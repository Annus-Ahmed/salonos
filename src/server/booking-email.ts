import { store } from "@/db/store";
import { bookings, customers } from "@/db/schema";
import {
  BOOKING_PAYMENT_LABELS,
  formatMoney,
  type BookingReceipt,
} from "@/lib/domain";

export async function sendBookingEmail(
  bookingId: string,
  receipt: BookingReceipt,
) {
  const db = store();
  const [booking] = await db.find(bookings, { id: bookingId });
  if (!booking) return "failed";
  if (booking.confirmationEmail) return booking.confirmationEmail;

  const [client] = await db.find(
    customers,
    { id: booking.customerId },
    { fields: ["email"] },
  );
  if (!client?.email) return "missing_email";

  const { RESEND_API_KEY: apiKey, BOOKING_EMAIL_FROM: from } = process.env;
  if (!apiKey || !from) return "unconfigured";

  const [claimed] = await db.update(
    bookings,
    { id: bookingId, confirmationEmail: null },
    { confirmationEmail: "pending" },
  );
  if (!claimed) return "pending";

  const confirmed = receipt.status === "confirmed";
  const subject =
    (confirmed ? "Booking confirmed" : "Booking inquiry received") +
    " — " +
    receipt.code;
  const text = [
    "Hello " + receipt.client + ",",
    "",
    confirmed
      ? "Your appointment with " + receipt.salon + " is confirmed."
      : receipt.salon +
        " received your booking inquiry. Your appointment is awaiting confirmation.",
    "",
    "Booking reference: " + receipt.code,
    "Date: " + receipt.date,
    "Time: " + receipt.time + " (Pakistan time)",
    "Services:",
    ...receipt.services.map((service) => "- " + service),
    "",
    "Subtotal: " + formatMoney(receipt.subtotal),
    "Discount: " + formatMoney(receipt.discount),
    "Net amount: " + formatMoney(receipt.net),
    "Advance paid: " + formatMoney(receipt.advance),
    "Remaining balance: " + formatMoney(receipt.remaining),
    "Payment method: " + BOOKING_PAYMENT_LABELS[receipt.method],
  ].join("\n");

  let status = "pending";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": "booking-confirmation/" + bookingId,
      },
      body: JSON.stringify({ from, to: [client.email], subject, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) status = "accepted";
    else if (response.status >= 400 && response.status < 500) status = "failed";
    await response.body?.cancel();
  } catch {
    // A timeout can occur after acceptance. Leave the result pending.
  }
  await db.update(
    bookings,
    { id: bookingId, confirmationEmail: "pending" },
    { confirmationEmail: status },
  );
  return status;
}
