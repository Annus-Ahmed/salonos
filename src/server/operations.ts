import { createHash, randomUUID } from "node:crypto";
import { inStoreTransaction, type Store } from "@/db/store";
import * as s from "@/db/schema";
import {
  DomainError,
  requireManager,
  money,
  normalizePhone,
  code,
  bookingBalance,
  financialDate,
  methodAccount,
  assertBalanced,
  today,
  type BookingReceipt,
  type Actor,
} from "@/lib/domain";
import * as v from "./validation";
export type Operation =
  | "client.save"
  | "service.save"
  | "booking.save"
  | "booking-payment.settings"
  | "booking.status"
  | "payment.receive"
  | "payment.verify"
  | "payment.reject"
  | "payment.refund"
  | "payment.reverse"
  | "expense.create"
  | "expense.settle"
  | "expense.reverse"
  | "product.create"
  | "stock.record";
function json(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}
export async function audit(
  tx: Store,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason?: string,
) {
  await tx.insert(s.auditLogs, {
    actorId: actor.id,
    action,
    entity,
    entityId,
    before: before === null ? null : json(before),
    after: after === null ? null : json(after),
    reason,
  });
}
async function journal(
  tx: Store,
  actor: Actor,
  date: string,
  sourceType: string,
  sourceId: string,
  event: string,
  description: string,
  lines: { accountCode: string; amountMinor: number; bookingId?: string }[],
) {
  const nonzero = lines.filter((l) => l.amountMinor !== 0);
  assertBalanced(nonzero);
  const [entry] = await tx.insert(s.journals, {
    date,
    sourceType,
    sourceId,
    event,
    description,
    createdBy: actor.id,
  });
  await tx.insert(
    s.ledgerLines,
    nonzero.map((line) => ({ ...line, journalId: entry.id })),
  );
}
async function booking(tx: Store, id: string) {
  const [b] = await tx.find(s.bookings, { id: id });
  if (!b) throw new DomainError("Booking not found.", 404);
  const ps = await tx.find(s.payments, { bookingId: id });
  return { b, ps, balance: bookingBalance(b, ps) };
}
function version(actual: number, expected: number | undefined) {
  if (actual !== expected)
    throw new DomainError(
      "This record changed since you opened it. Refresh before trying again.",
      409,
    );
}
function activeBooking(status: string) {
  if (["cancelled", "no_show"].includes(status))
    throw new DomainError(
      "This booking is closed. Refund any retained advance instead of taking more payments.",
    );
}
function bookingDate(b: typeof s.bookings.$inferSelect, date: string) {
  financialDate(date);
  if (b.completedDate && date < b.completedDate)
    throw new DomainError(
      "For a completed booking, use a payment/correction date on or after completion.",
    );
}
async function receiptLedger(
  tx: Store,
  actor: Actor,
  p: typeof s.payments.$inferSelect,
  b: typeof s.bookings.$inferSelect,
) {
  await journal(
    tx,
    actor,
    p.date,
    "payment",
    p.id,
    "receipt",
    `Receipt ${p.code}`,
    [
      {
        accountCode: methodAccount[p.method],
        amountMinor: p.amountMinor,
        bookingId: b.id,
      },
      {
        accountCode: b.status === "completed" ? "RECEIVABLES" : "ADVANCES",
        amountMinor: -p.amountMinor,
        bookingId: b.id,
      },
    ],
  );
}
const schemas = {
  "client.save": v.clientSchema,
  "service.save": v.serviceSchema,
  "booking.save": v.bookingSchema,
  "booking-payment.settings": v.bookingPaymentSettingsSchema,
  "booking.status": v.statusSchema,
  "payment.receive": v.paymentSchema,
  "payment.verify": v.correctionSchema,
  "payment.reject": v.correctionSchema,
  "payment.refund": v.refundSchema,
  "payment.reverse": v.correctionSchema,
  "expense.create": v.expenseSchema,
  "expense.settle": v.settleSchema,
  "expense.reverse": v.correctionSchema,
  "product.create": v.productSchema,
  "stock.record": v.stockSchema,
};
export async function execute(
  actor: Actor,
  operation: Operation,
  payload: unknown,
  key: string,
): Promise<any> {
  if (actor.role === "receptionist") {
    if (operation !== "client.save" && operation !== "booking.save")
      throw new DomainError(
        "Reception can only add clients and manage bookings.",
        403,
      );
  } else {
    requireManager(actor);
  }
  if (!schemas[operation]) throw new DomainError("Unknown operation.", 404);
  if (!/^[a-f0-9-]{36}$/i.test(key))
    throw new DomainError("A valid idempotency key is required.");
  const input = schemas[operation].parse(payload);
  if (
    actor.role === "receptionist" &&
    operation === "client.save" &&
    "id" in input &&
    input.id
  )
    throw new DomainError(
      "Reception can add clients. Client edits require a finance manager.",
      403,
    );
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await inStoreTransaction(async (tx) => {
        const [config] = await tx.find(s.settings, { id: 1 }, { lock: true });
        if (!config)
          throw new DomainError("Run database migrations first.", 503);
        const [existing] = await tx.find(s.commands, { key: key });
        if (existing) {
          if (
            existing.actorId !== actor.id ||
            existing.operation !== operation ||
            existing.hash !== hash
          )
            throw new DomainError(
              "This submission key was already used for different information.",
              409,
            );
          return existing.result;
        }
        await tx.update(s.settings, { id: 1 }, { version: config.version + 1 });
        const result = await run(tx, actor, operation, input);
        await tx.insert(s.commands, {
          key,
          actorId: actor.id,
          operation,
          hash,
          result: json(result),
        });
        return json(result);
      }, true);
    } catch (error: any) {
      const pgCode = error.code ?? error.cause?.code;
      if (pgCode === "40001" && attempt < 2) continue;
      if (pgCode === "23505" || pgCode === 11000)
        throw new DomainError(
          "A record with this phone number or reference already exists.",
          409,
        );
      if (pgCode === "23503")
        throw new DomainError(
          "A related record is unavailable. Refresh and try again.",
          409,
        );
      throw error;
    }
  }
  throw new DomainError("The record is busy. Please retry.", 409);
}
async function run(
  tx: Store,
  actor: Actor,
  operation: Operation,
  input: any,
): Promise<any> {
  switch (operation) {
    case "product.create": {
      const p = v.productSchema.parse(input);
      const [product] = await tx.insert(s.products, {
        sku: p.sku,
        name: p.name,
        retailPriceMinor: money(p.retailPrice),
      });
      await audit(tx, actor, "created", "product", product.id, null, product);
      return product;
    }
    case "stock.record": {
      const p = v.stockSchema.parse(input);
      financialDate(p.date);
      const [product] = await tx.find(s.products, { id: p.productId });
      if (!product) throw new DomainError("Select an inventory product.");
      const purchase = p.kind === "purchase";
      const retail = p.kind === "retail";
      const units = product.units + (purchase ? p.quantity : -p.quantity);
      if (units < 0 || units > 100000000)
        throw new DomainError(
          "Quantity exceeds available stock or the stock limit.",
        );
      const [latest] = await tx.find(
        s.stockMovements,
        { productId: product.id },
        { order: [["date", "desc"]], limit: 1 },
      );
      if (latest && latest.date > p.date)
        throw new DomainError(
          "Use a date on or after this product’s latest stock movement.",
        );
      const entered = money(p.amount);
      if ((purchase || retail) && entered <= 0)
        throw new DomainError("Enter a positive total amount.");
      const cost = purchase
        ? entered
        : Number(
            (BigInt(product.valueMinor) * BigInt(p.quantity)) /
              BigInt(product.units),
          );
      const valueMinor = product.valueMinor + (purchase ? cost : -cost);
      if (!Number.isSafeInteger(valueMinor))
        throw new DomainError("Inventory value exceeds the supported limit.");
      const [movement] = await tx.insert(s.stockMovements, {
        productId: product.id,
        kind: p.kind,
        date: p.date,
        quantity: p.quantity,
        costMinor: cost,
        saleMinor: retail ? entered : 0,
        method: p.method,
        note: p.note,
      });
      const [updated] = await tx.update(
        s.products,
        { id: product.id },
        { units, valueMinor },
      );
      const cash = methodAccount[p.method];
      const entries = purchase
        ? [
            { accountCode: "INVENTORY", amountMinor: cost },
            { accountCode: cash, amountMinor: -cost },
          ]
        : [
            { accountCode: "INVENTORY", amountMinor: -cost },
            {
              accountCode: retail ? "RETAIL_COST" : "OVERHEAD",
              amountMinor: cost,
            },
            ...(retail
              ? [
                  { accountCode: cash, amountMinor: entered },
                  { accountCode: "RETAIL_REVENUE", amountMinor: -entered },
                ]
              : []),
          ];
      if (entries.some((line) => line.amountMinor !== 0))
        await journal(
          tx,
          actor,
          p.date,
          "stock",
          movement.id,
          p.kind,
          product.name,
          entries,
        );
      await audit(tx, actor, p.kind, "product", product.id, product, {
        ...updated,
        movement,
      });
      return movement;
    }
    case "client.save": {
      const p = v.clientSchema.parse(input);
      const phone = normalizePhone(p.phone);
      const values = {
        name: p.name,
        phone,
        whatsapp: p.whatsapp ? normalizePhone(p.whatsapp) : phone,
        email: p.email.toLowerCase(),
        instagram: p.instagram,
        address: p.address,
        type: p.type,
        notes: p.notes,
      };
      let result;
      if (p.id) {
        const [old] = await tx.find(s.customers, { id: p.id });
        if (!old) throw new DomainError("Client not found.", 404);
        version(old.version, p.version);
        [result] = await tx.update(
          s.customers,
          { id: p.id },
          { ...values, version: old.version + 1 },
        );
        await audit(tx, actor, "updated", "client", p.id, old, result);
      } else {
        const id = randomUUID();
        [result] = await tx.insert(s.customers, {
          ...values,
          id,
          code: code("CL", id),
        });
        await audit(tx, actor, "created", "client", id, null, result);
      }
      return result;
    }
    case "booking-payment.settings": {
      const p = v.bookingPaymentSettingsSchema.parse(input);
      const [previous] = await tx.find(s.settings, { id: 1 });
      const [updated] = await tx.update(
        s.settings,
        { id: 1 },
        { bankQrUrl: p.bankQrUrl || null },
      );
      await audit(
        tx,
        actor,
        "updated",
        "booking_payment_settings",
        actor.id,
        { bankQrUrl: previous.bankQrUrl },
        { bankQrUrl: updated.bankQrUrl },
      );
      return { bankQrUrl: updated.bankQrUrl };
    }
    case "service.save": {
      const p = v.serviceSchema.parse(input);
      const details = p.details?.map((detail) => ({
        id: detail.id ?? randomUUID(),
        name: detail.name,
        priceMinor: money(detail.price),
      }));
      if (
        details &&
        (new Set(details.map((detail) => detail.id)).size !== details.length ||
          new Set(details.map((detail) => detail.name.toLowerCase())).size !==
            details.length)
      )
        throw new DomainError("Use a different name for each sub-service.");
      const values = {
        ...(details ? { details } : {}),
        name: p.name,
        category: p.category,
        description: p.description,
        priceMinor: money(p.price),
        durationMinutes: p.durationMinutes,
        estimatedCostMinor: money(p.estimatedCost),
        active: p.active,
      };
      let result;
      if (p.id) {
        const [old] = await tx.find(s.services, { id: p.id });
        if (!old) throw new DomainError("Service not found.", 404);
        version(old.version, p.version);
        [result] = await tx.update(
          s.services,
          { id: p.id },
          { ...values, version: old.version + 1 },
        );
        await audit(tx, actor, "updated", "service", p.id, old, result);
      } else {
        const id = randomUUID();
        [result] = await tx.insert(s.services, {
          ...values,
          id,
          code: code("SV", id),
        });
        await audit(tx, actor, "created", "service", id, null, result);
      }
      return result;
    }
    case "booking.save": {
      const p = v.bookingSchema.parse(input);
      const [client] = await tx.find(s.customers, {
        id: p.customerId,
        archived: false,
      });
      if (!client) throw new DomainError("Select an available client.");
      const editing = p.id ? await booking(tx, p.id) : null;
      if (editing) {
        version(editing.b.version, p.version);
        if (["completed", "cancelled", "no_show"].includes(editing.b.status))
          throw new DomainError(
            "Closed booking invoices cannot be edited. Use refunds or payment corrections.",
          );
      }
      const previousItems = p.id
        ? await tx.find(s.bookingItems, { bookingId: p.id })
        : [];
      const used = new Set<string>();
      const items = [];
      for (const line of p.items) {
        const previous = previousItems.find((item) => item.id === line.id);
        if (line.id && (!previous || used.has(line.id)))
          throw new DomainError("Invalid booking service line.");
        if (line.id) used.add(line.id);
        const detailId = line.detailId ?? null;
        const unchanged =
          previous &&
          previous.serviceId === line.serviceId &&
          (previous.detailId ?? null) === detailId;
        const [svc] = await tx.find(s.services, { id: line.serviceId });
        if (!svc || (!svc.active && !unchanged))
          throw new DomainError("Choose an active service.");
        const detail = svc.details?.find((detail) => detail.id === detailId);
        if (detailId && !detail && !unchanged)
          throw new DomainError(
            "Select a sub-service belonging to the selected service.",
          );
        const unitPriceMinor = unchanged
          ? previous.unitPriceMinor
          : (detail?.priceMinor ?? svc.priceMinor);
        if (line.price !== undefined && money(line.price) !== unitPriceMinor)
          throw new DomainError(
            "Use the current catalogue price. Refresh the form and try again.",
            409,
          );
        items.push({
          serviceId: svc.id,
          name: unchanged ? previous.name : svc.name,
          detailId,
          detailName: unchanged
            ? (previous.detailName ?? null)
            : (detail?.name ?? null),
          customName: line.customName,
          category: unchanged ? previous.category : svc.category,
          unitPriceMinor,
          quantity: line.quantity,
          lineTotalMinor: unitPriceMinor * line.quantity,
          estimatedCostMinor: svc.estimatedCostMinor * line.quantity,
        });
      }
      const subtotalMinor = items.reduce((a, l) => a + l.lineTotalMinor, 0);
      const discountMinor = money(p.discount);
      if (actor.role === "receptionist") {
        if (discountMinor !== (editing?.b.discountMinor ?? 0))
          throw new DomainError(
            "Only the finance manager can change the discount.",
            403,
          );
      }
      if (discountMinor > subtotalMinor)
        throw new DomainError("Discount cannot exceed the service total.");
      const totalMinor = subtotalMinor - discountMinor;
      if (totalMinor <= 0 || totalMinor > 1e12)
        throw new DomainError(
          "Booking total must be positive and below PKR 10 billion.",
        );
      const values = {
        customerId: p.customerId,
        appointmentDate: p.appointmentDate,
        appointmentTime: p.appointmentTime,
        category: p.category,
        artist: p.artist,
        hairstylist: p.hairstylist,
        notes: p.notes,
        subtotalMinor,
        discountMinor,
        totalMinor,
      };
      if (actor.role === "receptionist" && !p.id && !p.paymentMethod)
        throw new DomainError("Select a payment method.");
      const advance = money(p.advance);
      if (advance > totalMinor)
        throw new DomainError("Advance exceeds the net amount.");
      if (advance && (!p.paymentMethod || p.id))
        throw new DomainError(
          "An advance requires a payment method and a new booking.",
        );
      let result;
      if (editing) {
        const { b, ps, balance } = editing;
        if (ps.length && p.customerId !== b.customerId)
          throw new DomainError(
            "A booking with payment history cannot be moved to another client.",
          );
        if (!p.reason || p.reason.trim().length < 5)
          throw new DomainError("Explain why the booking is being changed.");
        if (totalMinor < balance.collected)
          throw new DomainError(
            "New total is below money already received. Refund the difference first.",
          );
        const beforeItems = previousItems;
        await tx.remove(s.bookingItems, { bookingId: b.id });
        [result] = await tx.update(
          s.bookings,
          { id: b.id },
          { ...values, version: b.version + 1 },
        );
        await tx.insert(
          s.bookingItems,
          items.map((i) => ({ ...i, bookingId: b.id })),
        );
        await audit(
          tx,
          actor,
          "updated",
          "booking",
          b.id,
          { ...b, items: beforeItems },
          { ...result, items },
          p.reason,
        );
      } else {
        const id = randomUUID();
        [result] = await tx.insert(s.bookings, {
          ...values,
          id,
          status: p.initialStatus,
          initialPaymentMethod: p.paymentMethod ?? null,
          code: code("SB", id),
        });
        await tx.insert(
          s.bookingItems,
          items.map((i) => ({ ...i, bookingId: id })),
        );
        await audit(tx, actor, "created", "booking", id, null, {
          ...result,
          items,
        });
        if (advance && p.paymentMethod) {
          await run(tx, actor, "payment.receive", {
            bookingId: id,
            amount: p.advance,
            method: p.paymentMethod,
            date: today(),
            verified: true,
          });
        }
        if (p.paymentMethod) {
          const [settings] = await tx.find(s.settings, { id: 1 });
          const receipt: BookingReceipt = {
            salon: settings.name,
            client: client.name,
            code: result.code,
            date: result.appointmentDate,
            time: result.appointmentTime,
            status: result.status,
            services: items.map(
              (item) =>
                item.name +
                (item.detailName ? " - " + item.detailName : "") +
                (item.quantity > 1 ? " × " + item.quantity : ""),
            ),
            subtotal: subtotalMinor,
            discount: discountMinor,
            net: totalMinor,
            advance,
            remaining: totalMinor - advance,
            method: p.paymentMethod,
          };
          return { ...result, receipt };
        }
      }
      return result;
    }
    case "booking.status": {
      const p = v.statusSchema.parse(input);
      const { b, ps, balance } = await booking(tx, p.id);
      version(b.version, p.version);
      const transitions: Record<string, string[]> = {
        inquiry: ["confirmed", "cancelled", "no_show"],
        confirmed: [
          "inquiry",
          "in_progress",
          "completed",
          "cancelled",
          "no_show",
        ],
        in_progress: ["completed", "cancelled"],
        completed: [],
        cancelled: [],
        no_show: [],
      };
      if (!transitions[b.status].includes(p.status))
        throw new DomainError("This status change is not permitted.");
      financialDate(p.date);
      if (
        ["cancelled", "no_show"].includes(p.status) &&
        (!p.reason || p.reason.length < 5)
      )
        throw new DomainError(
          "A reason is required to close a booking without service.",
        );
      if (p.status === "completed") {
        if (p.date < b.appointmentDate)
          throw new DomainError(
            "Completion cannot be before the appointment. Update the appointment date if needed.",
          );
        const latest = ps
          .filter((p) => p.status === "posted")
          .map((p) => p.date)
          .sort()
          .at(-1);
        if (latest && p.date < latest)
          throw new DomainError(
            "Complete on or after the latest posted payment date. For historical entry, record completion before later receipts.",
          );
        await journal(
          tx,
          actor,
          p.date,
          "booking",
          b.id,
          "completed",
          `Services completed: ${b.code}`,
          [
            {
              accountCode: "RECEIVABLES",
              amountMinor: b.totalMinor - balance.collected,
              bookingId: b.id,
            },
            {
              accountCode: "ADVANCES",
              amountMinor: balance.collected,
              bookingId: b.id,
            },
            {
              accountCode: "REVENUE",
              amountMinor: -b.totalMinor,
              bookingId: b.id,
            },
          ],
        );
      }
      const [result] = await tx.update(
        s.bookings,
        { id: b.id },
        {
          status: p.status,
          version: b.version + 1,
          ...(p.status === "completed" ? { completedDate: p.date } : {}),
          ...(["cancelled", "no_show"].includes(p.status)
            ? { cancelReason: p.reason }
            : {}),
        },
      );
      await audit(
        tx,
        actor,
        "status_changed",
        "booking",
        b.id,
        b,
        result,
        p.reason,
      );
      return result;
    }
    case "payment.receive": {
      const p = v.paymentSchema.parse(input);
      const { b, balance } = await booking(tx, p.bookingId);
      activeBooking(b.status);
      bookingDate(b, p.date);
      const amountMinor = money(p.amount);
      if (amountMinor <= 0)
        throw new DomainError("Payment must be greater than zero.");
      if (amountMinor > balance.outstanding)
        throw new DomainError(
          "Payment exceeds the outstanding balance. Check the amount.",
        );
      const id = randomUUID();
      const [result] = await tx.insert(s.payments, {
        id,
        code: code("RC", id),
        bookingId: b.id,
        kind: "receipt",
        status: p.verified ? "posted" : "unverified",
        amountMinor,
        signedMinor: p.verified ? amountMinor : 0,
        creditMinor: 0,
        method: p.method,
        date: p.date,
        reference: p.reference,
        notes: p.notes,
        createdBy: actor.id,
      });
      if (p.verified) await receiptLedger(tx, actor, result, b);
      await audit(
        tx,
        actor,
        p.verified ? "received" : "reported_unverified",
        "payment",
        id,
        null,
        result,
      );
      return result;
    }
    case "payment.verify": {
      const p = v.correctionSchema.parse(input);
      const [old] = await tx.find(s.payments, { id: p.id });
      if (!old || old.status !== "unverified")
        throw new DomainError("Only an unverified receipt can be verified.");
      const { b, balance } = await booking(tx, old.bookingId);
      activeBooking(b.status);
      bookingDate(b, old.date);
      if (old.amountMinor > balance.outstanding)
        throw new DomainError(
          "This reported receipt would overpay the booking. It has not been posted.",
        );
      const [result] = await tx.update(
        s.payments,
        { id: old.id },
        { status: "posted", signedMinor: old.amountMinor },
      );
      await receiptLedger(tx, actor, result, b);
      await audit(
        tx,
        actor,
        "verified",
        "payment",
        old.id,
        old,
        result,
        p.reason,
      );
      return result;
    }
    case "payment.reject": {
      const p = v.correctionSchema.parse(input);
      const [old] = await tx.find(s.payments, { id: p.id });
      if (!old || old.status !== "unverified")
        throw new DomainError("Only an unverified receipt can be rejected.");
      const [result] = await tx.update(
        s.payments,
        { id: old.id },
        { status: "rejected", reason: p.reason },
      );
      await audit(
        tx,
        actor,
        "rejected",
        "payment",
        old.id,
        old,
        result,
        p.reason,
      );
      return result;
    }
    case "payment.refund": {
      const p = v.refundSchema.parse(input);
      const [source] = await tx.find(s.payments, { id: p.paymentId });
      if (!source || source.kind !== "receipt" || source.status !== "posted")
        throw new DomainError("Select a posted receipt to refund.");
      const { b, ps, balance } = await booking(tx, source.bookingId);
      bookingDate(b, p.date);
      if (p.date < source.date)
        throw new DomainError("Refund cannot be before the receipt.");
      if (ps.some((p) => p.reversalOfId === source.id))
        throw new DomainError("This receipt was reversed.");
      const refunded = ps
        .filter(
          (p) =>
            p.parentId === source.id &&
            p.kind === "refund" &&
            !ps.some((r) => r.reversalOfId === p.id),
        )
        .reduce((a, p) => a + p.amountMinor, 0);
      const amountMinor = money(p.amount);
      if (
        amountMinor <= 0 ||
        amountMinor > source.amountMinor - refunded ||
        amountMinor > balance.collected
      )
        throw new DomainError("Refund exceeds the refundable amount.");
      const id = randomUUID();
      const creditMinor = b.status === "completed" ? amountMinor : 0;
      const [result] = await tx.insert(s.payments, {
        id,
        code: code("RF", id),
        bookingId: b.id,
        kind: "refund",
        status: "posted",
        amountMinor,
        signedMinor: -amountMinor,
        creditMinor,
        method: p.method,
        date: p.date,
        parentId: source.id,
        reason: p.reason,
        createdBy: actor.id,
      });
      await journal(
        tx,
        actor,
        p.date,
        "payment",
        id,
        "refund",
        `Refund ${result.code}`,
        [
          {
            accountCode: creditMinor ? "SALES_RETURNS" : "ADVANCES",
            amountMinor,
            bookingId: b.id,
          },
          {
            accountCode: methodAccount[p.method],
            amountMinor: -amountMinor,
            bookingId: b.id,
          },
        ],
      );
      await audit(tx, actor, "refunded", "payment", id, null, result, p.reason);
      return result;
    }
    case "payment.reverse": {
      const p = v.correctionSchema.parse(input);
      const [source] = await tx.find(s.payments, { id: p.id });
      if (!source || source.status !== "posted" || source.kind === "reversal")
        throw new DomainError("Select a posted receipt or refund to reverse.");
      const { b, ps, balance } = await booking(tx, source.bookingId);
      bookingDate(b, p.date);
      if (p.date < source.date)
        throw new DomainError(
          "Correction cannot predate the original transaction.",
        );
      if (ps.some((r) => r.reversalOfId === source.id))
        throw new DomainError("This transaction has already been reversed.");
      if (
        source.kind === "receipt" &&
        ps.some(
          (p) =>
            p.parentId === source.id &&
            p.kind === "refund" &&
            !ps.some((r) => r.reversalOfId === p.id),
        )
      )
        throw new DomainError(
          "Reverse the linked refunds before reversing this receipt.",
        );
      if (
        source.kind === "refund" &&
        balance.collected + source.amountMinor >
          b.totalMinor - (balance.credits - source.creditMinor)
      )
        throw new DomainError(
          "Reversing this refund would create an overpayment.",
        );
      const id = randomUUID();
      const signedMinor = -source.signedMinor;
      const [result] = await tx.insert(s.payments, {
        id,
        code: code("RV", id),
        bookingId: b.id,
        kind: "reversal",
        status: "posted",
        amountMinor: source.amountMinor,
        signedMinor,
        creditMinor: -source.creditMinor,
        method: source.method,
        date: p.date,
        reversalOfId: source.id,
        reason: p.reason,
        createdBy: actor.id,
      });
      const contra = source.creditMinor
        ? "SALES_RETURNS"
        : b.status === "completed"
          ? "RECEIVABLES"
          : "ADVANCES";
      await journal(
        tx,
        actor,
        p.date,
        "payment",
        id,
        "correction",
        `Correction of ${source.code}`,
        [
          {
            accountCode: methodAccount[source.method],
            amountMinor: signedMinor,
            bookingId: b.id,
          },
          { accountCode: contra, amountMinor: -signedMinor, bookingId: b.id },
        ],
      );
      await audit(
        tx,
        actor,
        "reversed",
        "payment",
        source.id,
        source,
        result,
        p.reason,
      );
      return result;
    }
    case "expense.create": {
      const p = v.expenseSchema.parse(input);
      financialDate(p.date);
      const amountMinor = money(p.amount);
      if (amountMinor <= 0)
        throw new DomainError("Expense amount must be positive.");
      if (p.bookingId) await booking(tx, p.bookingId);
      if (p.classification === "direct" && !p.bookingId)
        throw new DomainError("Link a direct cost to its booking.");
      if (p.classification !== "direct" && p.bookingId)
        throw new DomainError(
          "Only direct costs should be linked to a booking.",
        );
      const id = randomUUID();
      const [result] = await tx.insert(s.expenses, {
        id,
        code: code("EX", id),
        date: p.date,
        category: p.category,
        classification: p.classification,
        amountMinor,
        payee: p.payee,
        description: p.description,
        method: p.paid ? p.method : null,
        bookingId: p.bookingId || null,
        paid: p.paid,
        paidDate: p.paid ? p.date : null,
        notes: p.notes,
        createdBy: actor.id,
      });
      await journal(
        tx,
        actor,
        p.date,
        "expense",
        id,
        "recorded",
        p.description,
        [
          {
            accountCode:
              p.classification === "capital"
                ? "EQUIPMENT"
                : p.classification === "direct"
                  ? "DIRECT_COST"
                  : "OVERHEAD",
            amountMinor,
            bookingId: p.bookingId || undefined,
          },
          {
            accountCode: p.paid ? methodAccount[p.method] : "PAYABLES",
            amountMinor: -amountMinor,
            bookingId: p.bookingId || undefined,
          },
        ],
      );
      await audit(tx, actor, "created", "expense", id, null, result);
      return result;
    }
    case "expense.settle": {
      const p = v.settleSchema.parse(input);
      financialDate(p.date);
      const [old] = await tx.find(s.expenses, { id: p.id });
      if (!old || old.paid || old.voided)
        throw new DomainError("Select an unpaid, active expense.");
      if (p.date < old.date)
        throw new DomainError("Payment cannot predate the expense.");
      const [result] = await tx.update(
        s.expenses,
        { id: old.id },
        { paid: true, paidDate: p.date, method: p.method },
      );
      await journal(
        tx,
        actor,
        p.date,
        "expense",
        old.id,
        "settled",
        `Settled ${old.code}`,
        [
          { accountCode: "PAYABLES", amountMinor: old.amountMinor },
          {
            accountCode: methodAccount[p.method],
            amountMinor: -old.amountMinor,
          },
        ],
      );
      await audit(tx, actor, "settled", "expense", old.id, old, result);
      return result;
    }
    case "expense.reverse": {
      const p = v.correctionSchema.parse(input);
      financialDate(p.date);
      const [old] = await tx.find(s.expenses, { id: p.id });
      if (!old || old.voided)
        throw new DomainError(
          "This expense is unavailable or already reversed.",
        );
      if (p.date < (old.paidDate ?? old.date))
        throw new DomainError(
          "Correction cannot predate the expense or its settlement.",
        );
      const [result] = await tx.update(
        s.expenses,
        { id: old.id },
        { voided: true },
      );
      await journal(
        tx,
        actor,
        p.date,
        "expense",
        old.id,
        "reversed",
        `Reversed ${old.code}`,
        [
          {
            accountCode:
              old.classification === "capital"
                ? "EQUIPMENT"
                : old.classification === "direct"
                  ? "DIRECT_COST"
                  : "OVERHEAD",
            amountMinor: -old.amountMinor,
            bookingId: old.bookingId || undefined,
          },
          {
            accountCode: old.paid ? methodAccount[old.method!] : "PAYABLES",
            amountMinor: old.amountMinor,
            bookingId: old.bookingId || undefined,
          },
        ],
      );
      await audit(
        tx,
        actor,
        "reversed",
        "expense",
        old.id,
        old,
        result,
        p.reason,
      );
      return result;
    }
  }
}
