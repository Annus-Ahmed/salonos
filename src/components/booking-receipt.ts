import {
  BOOKING_PAYMENT_LABELS,
  formatMoney,
  type BookingReceipt,
} from "@/lib/domain";

export function printBookingReceipt(receipt: BookingReceipt) {
  const frame = document.createElement("iframe");
  frame.title = "Print booking receipt";
  frame.style.cssText = "position:fixed;width:0;height:0;border:0";
  document.body.append(frame);
  const doc = frame.contentDocument;
  const target = frame.contentWindow;
  if (!doc || !target) {
    frame.remove();
    throw new Error("Receipt print window unavailable.");
  }
  doc.title = "Receipt " + receipt.code;
  const style = doc.createElement("style");
  style.textContent =
    "@page{margin:3mm}body{font:12px monospace;color:#000;max-width:68mm;margin:0 auto}h1{font-size:16px;text-align:center}p{margin:5px 0;overflow-wrap:anywhere}hr{border:0;border-top:1px dashed}";
  doc.head.append(style);
  const add = (tag: string, value: string) => {
    const node = doc.createElement(tag);
    node.textContent = value;
    doc.body.append(node);
  };
  add("h1", receipt.salon);
  add("p", "Booking " + receipt.code + " · " + receipt.status);
  add("p", "Client: " + receipt.client);
  add("p", receipt.date + " " + receipt.time + " (PKT)");
  add("hr", "");
  for (const service of receipt.services) add("p", service);
  add("hr", "");
  for (const [label, value] of [
    ["Total", receipt.subtotal],
    ["Discount", receipt.discount],
    ["Net amount", receipt.net],
    ["Advance paid", receipt.advance],
    ["Remaining", receipt.remaining],
  ] as const)
    add("p", label + ": " + formatMoney(value));
  add("p", "Payment method: " + BOOKING_PAYMENT_LABELS[receipt.method]);
  target.addEventListener("afterprint", () => frame.remove(), { once: true });
  target.focus();
  target.print();
}
