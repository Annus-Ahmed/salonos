import { inStoreTransaction } from "@/db/store";
import * as s from "@/db/schema";
import { bookingBalance, dayOf, addDays, type Actor } from "@/lib/domain";
export async function snapshot(actor: Actor) {
  return inStoreTransaction(async (tx) => {
    const config = await tx.find(s.settings, { id: 1 });
    const customers = await tx.find(
      s.customers,
      {},
      { order: [["createdAt", "desc"]] },
    );
    const services = await tx.find(
      s.services,
      {},
      {
        order: [
          ["category", "asc"],
          ["name", "asc"],
        ],
      },
    );
    const rawBookings = await tx.find(
      s.bookings,
      {},
      { order: [["appointmentDate", "desc"]] },
    );
    const items = await tx.find(s.bookingItems);
    const payments = await tx.find(
      s.payments,
      {},
      { order: [["createdAt", "desc"]] },
    );
    const reception = actor.role === "receptionist";
    const expenses = reception
      ? []
      : await tx.find(s.expenses, {}, { order: [["date", "desc"]] });
    const journals = reception ? [] : await tx.find(s.journals);
    const lines = reception ? [] : await tx.find(s.ledgerLines);
    const audit = reception
      ? []
      : await tx.find(
          s.auditLogs,
          {},
          { order: [["createdAt", "desc"]], limit: 200 },
        );
    const users = reception
      ? []
      : await tx.find(s.users, {}, { fields: ["id", "name", "email", "role"] });
    const attachments = reception
      ? []
      : await tx.find(
          s.attachments,
          {},
          { fields: ["id", "entity", "entityId", "name", "size"] },
        );
    const products = reception
      ? []
      : await tx.find(s.products, {}, { order: [["name", "asc"]] });
    const stockMovements = reception
      ? []
      : await tx.find(s.stockMovements, {}, { order: [["createdAt", "desc"]] });
    const ledger = lines.map((l) => ({
      ...l,
      ...journals.find((j) => j.id === l.journalId),
      id: l.id,
    }));
    const bookings = rawBookings.map((b) => {
      const ps = payments.filter((p) => p.bookingId === b.id);
      const client = customers.find((c) => c.id === b.customerId);
      return {
        ...b,
        clientName: client?.name ?? "Unknown client",
        clientPhone: client?.phone ?? "",
        items: items.filter((i) => i.bookingId === b.id),
        payments: ps,
        ...bookingBalance(b, ps),
        directCostMinor: ledger
          .filter(
            (l) => l.bookingId === b.id && l.accountCode === "DIRECT_COST",
          )
          .reduce((a, l) => a + l.amountMinor, 0),
      };
    });
    if (actor.role === "receptionist") {
      return JSON.parse(
        JSON.stringify({
          config: config[0],
          actor,
          customers,
          services: services
            .filter((service) => service.active)
            .map(({ estimatedCostMinor, ...service }) => service),
          bookings: bookings.map(
            ({ payments, directCostMinor, ...booking }) => ({
              ...booking,
              items: booking.items.map(
                ({ estimatedCostMinor, ...item }) => item,
              ),
            }),
          ),
          payments: [],
          expenses: [],
          ledger: [],
          audit: [],
          users: [],
          attachments: [],
        }),
      );
    }
    return JSON.parse(
      JSON.stringify({
        config: config[0],
        actor,
        customers,
        services,
        bookings,
        payments,
        expenses,
        ledger,
        audit,
        users,
        attachments,
        products,
        stockMovements,
      }),
    );
  }, false);
}
export { summary, reportRows, REPORTS } from "@/lib/reporting";
export type { Snapshot, Summary, ReportKind } from "@/lib/reporting";
