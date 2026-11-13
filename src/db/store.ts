import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  getTableName,
  isNull,
  type SQL,
} from "drizzle-orm";
import { type PgTable } from "drizzle-orm/pg-core";
import {
  Binary,
  MongoClient,
  type ClientSession,
  type Document,
  type Filter,
} from "mongodb";
import { db, type Database, type Transaction } from "./index";
import * as tables from "./schema";
import { chartAccounts } from "@/lib/domain";

type Row<T extends PgTable> = T["$inferSelect"];
type Values<T extends PgTable> = T["$inferInsert"];
type Options<T extends PgTable> = {
  order?: [keyof Row<T> & string, "asc" | "desc"][];
  limit?: number;
  lock?: boolean;
  fields?: (keyof Row<T> & string)[];
};

let mongoClient: MongoClient | undefined;
export function useMongo() {
  return Boolean(process.env.MONGODB_URI);
}
export function mongo() {
  const uri = process.env.MONGODB_URI;
  const name = process.env.MONGODB_DATABASE;
  if (!uri || !name) throw new Error("Set MONGODB_URI and MONGODB_DATABASE.");
  mongoClient ??= new MongoClient(uri);
  return { client: mongoClient, database: mongoClient.db(name) };
}
export async function closeMongo() {
  await mongoClient?.close();
  mongoClient = undefined;
}

function sqlFilter(
  table: PgTable,
  match: Record<string, unknown>,
): SQL | undefined {
  const columns = getTableColumns(table);
  return and(
    ...Object.entries(match).map(([key, value]) =>
      value === null ? isNull(columns[key]) : eq(columns[key], value),
    ),
  );
}

export class Store {
  constructor(
    private readonly pg?: Database | Transaction,
    private readonly session?: ClientSession,
  ) {}

  async find<T extends PgTable>(
    table: T,
    match: Partial<Row<T>> = {},
    options: Options<T> = {},
  ): Promise<Row<T>[]> {
    if (!this.pg) {
      const projection = options.fields
        ? Object.fromEntries(options.fields.map((key) => [key, 1]))
        : {};
      let cursor = mongo()
        .database.collection(getTableName(table))
        .find(match as Filter<Document>, {
          session: this.session,
          projection: { ...projection, _id: 0 },
        });
      if (options.order)
        cursor = cursor.sort(
          options.order.map(
            ([key, direction]) => [key, direction === "asc" ? 1 : -1] as const,
          ),
        );
      if (options.limit) cursor = cursor.limit(options.limit);
      return (await cursor.toArray()).map((row) => {
        for (const [key, value] of Object.entries(row))
          if (value instanceof Binary) row[key] = Buffer.from(value.value());
        return row as Row<T>;
      });
    }
    const columns = getTableColumns(table);
    let query = (
      options.fields
        ? this.pg.select(
            Object.fromEntries(
              options.fields.map((key) => [key, columns[key]]),
            ),
          )
        : this.pg.select()
    )
      .from(table as PgTable)
      .where(sqlFilter(table, match))
      .$dynamic();
    if (options.order)
      query = query.orderBy(
        ...options.order.map(([key, direction]) =>
          (direction === "asc" ? asc : desc)(columns[key]),
        ),
      );
    if (options.limit) query = query.limit(options.limit);
    if (options.lock) query = query.for("update");
    return (await query) as Row<T>[];
  }

  async insert<T extends PgTable>(
    table: T,
    input: Values<T> | Values<T>[],
  ): Promise<Row<T>[]> {
    const values = Array.isArray(input) ? input : [input];
    if (this.pg)
      return (await this.pg
        .insert(table)
        .values(values)
        .returning()) as Row<T>[];
    const documents = values.map((value) => {
      const doc: Document = {};
      for (const [key, column] of Object.entries(getTableColumns(table))) {
        const supplied = (value as Record<string, unknown>)[key];
        if (supplied !== undefined) doc[key] = supplied;
        else if (
          column.columnType === "PgUUID" &&
          column.primary &&
          column.hasDefault
        )
          doc[key] = randomUUID();
        else if (column.columnType === "PgTimestamp" && column.hasDefault)
          doc[key] = new Date();
        else if (column.default !== undefined) doc[key] = column.default;
        else if (!column.notNull) doc[key] = null;
        else
          throw new Error(
            "Missing required value: " + getTableName(table) + "." + key,
          );
      }
      return doc;
    });
    await mongo()
      .database.collection(getTableName(table))
      .insertMany(
        documents.map((doc) => ({ ...doc })),
        { session: this.session },
      );
    return documents as Row<T>[];
  }

  async update<T extends PgTable>(
    table: T,
    match: Partial<Row<T>>,
    input: Partial<Values<T>>,
  ): Promise<Row<T>[]> {
    if (this.pg)
      return (await this.pg
        .update(table)
        .set(input)
        .where(sqlFilter(table, match))
        .returning()) as Row<T>[];
    const changes = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    const row = await mongo()
      .database.collection(getTableName(table))
      .findOneAndUpdate(
        match as Filter<Document>,
        { $set: changes },
        {
          session: this.session,
          returnDocument: "after",
          projection: { _id: 0 },
        },
      );
    return row ? [row as Row<T>] : [];
  }

  async remove<T extends PgTable>(
    table: T,
    match: Partial<Row<T>>,
  ): Promise<void> {
    if (this.pg) await this.pg.delete(table).where(sqlFilter(table, match));
    else
      await mongo()
        .database.collection(getTableName(table))
        .deleteMany(match as Filter<Document>, { session: this.session });
  }
}

export function store() {
  return useMongo() ? new Store() : new Store(db());
}

export async function inStoreTransaction<T>(
  work: (store: Store) => Promise<T>,
  write: boolean,
): Promise<T> {
  if (!useMongo())
    return db().transaction((tx) => work(new Store(tx)), {
      isolationLevel: write ? "serializable" : "repeatable read",
    });
  const { client } = mongo();
  return client.withSession((session) =>
    session.withTransaction(() => work(new Store(undefined, session)), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    }),
  );
}

export async function initializeMongo() {
  const { database } = mongo();
  const topology = await database.command({ hello: 1 });
  if (!topology.setName && topology.msg !== "isdbgrid")
    throw new Error("SalonOS needs MongoDB replica set transactions.");
  for (const table of Object.values(tables)) {
    const collection = database.collection(getTableName(table));
    try {
      await database.createCollection(collection.collectionName);
    } catch (error) {
      if ((error as { code?: number }).code !== 48) throw error;
    }
    for (const [key, column] of Object.entries(getTableColumns(table))) {
      if (column.primary || column.isUnique)
        await collection.createIndex(
          { [key]: 1 },
          {
            unique: true,
            ...(column.notNull
              ? {}
              : { partialFilterExpression: { [key]: { $type: "string" } } }),
          },
        );
    }
  }
  await database
    .collection("journals")
    .createIndex({ sourceType: 1, sourceId: 1, event: 1 }, { unique: true });
  await database.collection("booking_items").createIndex({ bookingId: 1 });
  await database.collection("payments").createIndex({ bookingId: 1 });
  await database
    .collection("stock_movements")
    .createIndex({ productId: 1, date: -1 });
  await database
    .collection("sessions")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await database.collection("settings").updateOne(
    { id: 1 },
    {
      $setOnInsert: {
        id: 1,
        name: "SalonOS Studio",
        demo: process.env.DEMO_MODE === "true",
        version: 1,
      },
    },
    { upsert: true },
  );
  for (const [code, name, type] of chartAccounts)
    await database
      .collection("accounts")
      .updateOne(
        { code },
        { $setOnInsert: { code, name, type } },
        { upsert: true },
      );
}
