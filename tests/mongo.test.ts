import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeMongo, mongo, closeMongo, store } from "../src/db/store";
import * as s from "../src/db/schema";
import { hashPassword, login, actorFromToken } from "../src/server/auth";
import { execute } from "../src/server/operations";
import { sendBookingConfirmation } from "../src/server/booking-sms";
import { snapshot } from "../src/server/queries";
import { today } from "../src/lib/domain";

test(
  "MongoDB replica set supports SalonOS permissions and financial transactions",
  {
    skip: !process.env.TEST_MONGODB_URI,
  },
  async () => {
    process.env.MONGODB_URI = process.env.TEST_MONGODB_URI;
    process.env.MONGODB_DATABASE =
      "salonos_test_" + randomUUID().replaceAll("-", "");
    process.env.SESSION_SECRET =
      "test-session-secret-32-characters-minimum-123456";
    try {
      await initializeMongo();
      const password = "Testing-password-123";
      const passwordHash = await hashPassword(password);
      const [manager, receptionist, owner] = await store().insert(s.users, [
        {
          name: "Manager",
          email: "manager@example.test",
          role: "finance_manager",
          passwordHash,
        },
        {
          name: "Receptionist",
          email: "reception@example.test",
          role: "receptionist",
          passwordHash,
        },
        {
          name: "Owner",
          email: "owner@example.test",
          role: "owner",
          passwordHash,
        },
      ]);
      const loggedIn = await login(receptionist.email, password, "test");
      assert.equal(
        (await actorFromToken(loggedIn.token))?.role,
        "receptionist",
      );
      const client = await execute(
        receptionist,
        "client.save",
        { name: "Client", phone: "+923001234567" },
        randomUUID(),
      );
      const service = await execute(
        manager,
        "service.save",
        {
          name: "Full facial",
          category: "Facial",
          price: "1500",
          durationMinutes: 45,
          details: [{ name: "Mask only", price: "500" }],
        },
        randomUUID(),
      );
      await assert.rejects(
        execute(receptionist, "service.save", {}, randomUUID()),
        /reception/i,
      );
      await assert.rejects(
        execute(owner, "client.save", {}, randomUUID()),
        /read-only/i,
      );
      const booking = await execute(
        receptionist,
        "booking.save",
        {
          customerId: client.id,
          appointmentDate: today(),
          appointmentTime: "16:00",
          category: "Salon",
          paymentMethod: "Cash",
          advance: "50",
          items: [
            {
              serviceId: service.id,
              customName: "Mask only",
              detailId: service.details[0].id,
              price: "500",
              quantity: 1,
            },
          ],
        },
        randomUUID(),
      );
      const fetchBefore = globalThis.fetch;
      const previousTwilio = {
        sid: process.env.TWILIO_ACCOUNT_SID,
        token: process.env.TWILIO_AUTH_TOKEN,
        from: process.env.TWILIO_FROM,
      };
      let messages = 0;
      try {
        process.env.TWILIO_ACCOUNT_SID = "test";
        process.env.TWILIO_AUTH_TOKEN = "test";
        process.env.TWILIO_FROM = "+923001234567";
        globalThis.fetch = async (_url, options) => {
          messages++;
          assert.equal(
            (options?.body as URLSearchParams).get("To"),
            client.phone,
          );
          assert.match(
            (options?.body as URLSearchParams).get("Body") ?? "",
            /Booking Confirmed/,
          );
          return new Response(null, { status: 201 });
        };
        assert.equal(
          await sendBookingConfirmation(booking.id, booking.receipt),
          "accepted",
        );
        assert.equal(
          await sendBookingConfirmation(booking.id, booking.receipt),
          "accepted",
        );
        assert.equal(messages, 1);
      } finally {
        globalThis.fetch = fetchBefore;
        for (const [key, value] of Object.entries({
          TWILIO_ACCOUNT_SID: previousTwilio.sid,
          TWILIO_AUTH_TOKEN: previousTwilio.token,
          TWILIO_FROM: previousTwilio.from,
        })) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assert.equal(booking.receipt.remaining, 45000);
      assert.deepEqual(booking.receipt.services, ["Full facial - Mask only"]);
      const payment = {
        bookingId: booking.id,
        amount: "400",
        method: "Cash",
        date: today(),
      };
      const receipts = await Promise.allSettled([
        execute(manager, "payment.receive", payment, randomUUID()),
        execute(manager, "payment.receive", payment, randomUUID()),
      ]);
      assert.equal(
        receipts.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const product = await execute(
        manager,
        "product.create",
        {
          sku: "MASK",
          name: "Face mask",
          retailPrice: "50",
        },
        randomUUID(),
      );
      await execute(
        manager,
        "stock.record",
        {
          productId: product.id,
          kind: "purchase",
          quantity: 10,
          amount: "200",
          method: "Cash",
          date: today(),
        },
        randomUUID(),
      );
      await execute(
        manager,
        "stock.record",
        {
          productId: product.id,
          kind: "retail",
          quantity: 3,
          amount: "150",
          method: "Cash",
          date: today(),
        },
        randomUUID(),
      );
      const salary = await execute(
        manager,
        "expense.create",
        {
          date: today(),
          category: "Salaries",
          classification: "overhead",
          amount: "350",
          payee: "Salon assistant",
          description: "November salary",
          method: "Cash",
          paid: false,
        },
        randomUUID(),
      );
      await execute(
        manager,
        "expense.settle",
        { id: salary.id, date: today(), method: "Cash" },
        randomUUID(),
      );
      const ownerView = await snapshot(owner);
      assert.equal(ownerView.products[0].units, 7);
      assert.equal(ownerView.products[0].valueMinor, 14000);
      assert.equal(ownerView.expenses[0].paid, true);
      assert.equal(ownerView.bookings[0].outstanding, 5000);
      assert.equal(ownerView.bookings[0].items[0].customName, "Mask only");
      assert.equal(
        ownerView.ledger.reduce(
          (total: number, line: { amountMinor: number }) =>
            total + line.amountMinor,
          0,
        ),
        0,
      );
      assert.deepEqual((await snapshot(receptionist)).ledger, []);
    } finally {
      await mongo().database.dropDatabase();
      await closeMongo();
    }
  },
);
