import { store } from "@/db/store";
import { bookings, customers } from "@/db/schema";
import { formatMoney, type BookingReceipt } from "@/lib/domain";

export async function sendBookingConfirmation(
  bookingId: string,
  receipt: BookingReceipt,
) {
  const {
    TWILIO_ACCOUNT_SID: sid,
    TWILIO_AUTH_TOKEN: token,
    TWILIO_FROM: from,
  } = process.env;
  if (!sid || !token || !from) return "unconfigured";
  const db = store();
  const [booking] = await db.find(bookings, { id: bookingId });
  if (!booking) return "failed";
  if (booking.confirmationSms) return booking.confirmationSms;
  const [client] = await db.find(
    customers,
    { id: booking.customerId },
    { fields: ["phone"] },
  );
  if (!client?.phone) return "failed";
  const [claimed] = await db.update(
    bookings,
    { id: bookingId, confirmationSms: null },
    { confirmationSms: "pending" },
  );
  if (!claimed) return "pending";

  const title =
    receipt.status === "confirmed"
      ? "Booking Confirmed"
      : "Booking Inquiry Received";
  const body = [
    title,
    receipt.date + " " + receipt.time + " (PKT)",
    receipt.services.join(", "),
    "Advance Paid: " + formatMoney(receipt.advance),
    "Remaining: " + formatMoney(receipt.remaining),
  ].join("\n");
  let status = "failed";
  try {
    const response = await fetch(
      "https://api.twilio.com/2010-04-01/Accounts/" +
        encodeURIComponent(sid) +
        "/Messages.json",
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: client.phone, Body: body }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (response.ok) status = "accepted";
    await response.body?.cancel();
  } catch {
    // A timeout may mean the provider received the message. Do not resend automatically.
  }
  await db.update(
    bookings,
    { id: bookingId, confirmationSms: "pending" },
    { confirmationSms: status },
  );
  return status;
}
