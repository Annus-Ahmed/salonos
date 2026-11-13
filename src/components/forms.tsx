"use client";
import { useRef, useState } from "react";
import { Plus, ArrowRight, LoaderCircle } from "lucide-react";
import {
  CATEGORIES,
  BOOKING_PAYMENT_LABELS,
  BOOKING_PAYMENT_METHODS,
  type ServiceDetail,
  EXPENSE_CATEGORIES,
  METHODS,
  today,
  formatMoney,
} from "@/lib/domain";
import { printBookingReceipt } from "./booking-receipt";
import { useWorkspace } from "./workspace";
import { Modal, SearchSelect } from "./ui";
const amount = (v: number | undefined) => ((v ?? 0) / 100).toFixed(2);
export type FormKind =
  "clients" | "services" | "bookings" | "payments" | "expenses";
export function RecordForm({
  kind,
  record,
  onClose,
  onSaved,
}: {
  kind: FormKind;
  record?: any;
  onClose: () => void;
  onSaved?: (result: any) => void;
}) {
  const { data, mutate, notify, refresh } = useWorkspace();
  const d = data!;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  const previousInput = useRef("");
  const [customerId, setCustomerId] = useState(record?.customerId ?? "");
  const [bookingId, setBookingId] = useState(record?.bookingId ?? "");
  const [classification, setClassification] = useState(
    record?.classification ?? "overhead",
  );
  const [items, setItems] = useState<
    {
      id?: string;
      serviceId: string;
      detailId: string;
      customize: boolean;
      quantity: number;
      customName: string;
    }[]
  >(
    record?.items?.map((item: any) => ({
      id: item.id,
      serviceId: item.serviceId,
      detailId: item.detailId ?? "",
      customize: Boolean(item.detailId),
      quantity: item.quantity,
      customName: item.customName ?? "",
    })) ?? [
      {
        serviceId: "",
        detailId: "",
        customize: false,
        quantity: 1,
        customName: "",
      },
    ],
  );
  const [details, setDetails] = useState<
    { id?: string; name: string; price: string }[]
  >(
    record?.details?.map((detail: ServiceDetail) => ({
      id: detail.id,
      name: detail.name,
      price: amount(detail.priceMinor),
    })) ?? [],
  );
  const [paymentMethod, setPaymentMethod] = useState("");
  const [advance, setAdvance] = useState("");
  const updateItem = (
    index: number,
    changes: Partial<(typeof items)[number]>,
  ) =>
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, ...changes } : item)),
    );
  const previousLine = (item: (typeof items)[number]) =>
    record?.items?.find(
      (line: any) =>
        line.id === item.id &&
        line.serviceId === item.serviceId &&
        (line.detailId ?? "") === item.detailId,
    );
  const linePrice = (item: (typeof items)[number]) => {
    const previous = previousLine(item);
    const service = d.services.find((svc) => svc.id === item.serviceId);
    return (
      previous?.unitPriceMinor ??
      (item.detailId
        ? service?.details?.find(
            (detail: ServiceDetail) => detail.id === item.detailId,
          )?.priceMinor
        : service?.priceMinor) ??
      0
    );
  };
  const advanceMinor = Math.round(Number(advance) * 100);
  const [discount, setDiscount] = useState(amount(record?.discountMinor));
  const netMinor =
    items.reduce((sum, item) => sum + linePrice(item) * item.quantity, 0) -
    Math.round(Number(discount) * 100);
  const titles = {
    clients: record ? "Edit client" : "Add a client",
    services: record ? "Edit service" : "Add a service",
    bookings: record?.id ? "Update booking" : "Create a booking",
    payments: "Record a payment",
    expenses: "Record an expense",
  };
  const selectedBooking = d.bookings.find((b) => b.id === bookingId);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "");
    let payload: any = {};
    try {
      if (kind === "clients")
        payload = {
          name: str("name"),
          phone: str("phone"),
          whatsapp: str("whatsapp"),
          email: str("email"),
          instagram: str("instagram"),
          address: str("address"),
          type: str("type"),
          notes: str("notes"),
          ...(record ? { id: record.id, version: record.version } : {}),
        };
      if (kind === "services")
        payload = {
          name: str("name"),
          category: str("category"),
          description: str("description"),
          price: str("price"),
          estimatedCost: str("estimatedCost"),
          durationMinutes: Number(str("durationMinutes")),
          active: f.get("active") === "on",
          details,
          ...(record ? { id: record.id, version: record.version } : {}),
        };
      if (kind === "bookings") {
        if (!customerId)
          throw new Error("Select a client from the suggestions.");
        if (items.some((item) => item.customize && !item.detailId))
          throw new Error("Select a sub-service or turn customization off.");
        if (!record?.id && (!paymentMethod || advanceMinor > netMinor))
          throw new Error(
            "Choose a payment method and enter an advance within the net amount.",
          );
        if (items.some((i) => !i.serviceId))
          throw new Error("Choose a service for every line.");
        payload = {
          initialStatus: str("initialStatus") || "confirmed",
          customerId,
          appointmentDate: str("appointmentDate"),
          appointmentTime: str("appointmentTime"),
          category: str("category"),
          artist: str("artist"),
          hairstylist: str("hairstylist"),
          notes: str("notes"),
          discount: discount || "0",
          items: items.map(({ customize, detailId, ...item }) => ({
            ...item,
            detailId: detailId || null,
            price: amount(linePrice({ ...item, customize, detailId })),
          })),
          ...(!record?.id ? { paymentMethod, advance: advance || "0" } : {}),
          reason: str("reason"),
          ...(record?.id ? { id: record.id, version: record.version } : {}),
        };
      }
      if (kind === "payments") {
        if (!bookingId) throw new Error("Select a booking.");
        payload = {
          bookingId,
          amount: str("amount"),
          method: str("method"),
          date: str("date"),
          reference: str("reference"),
          notes: str("notes"),
          verified: f.get("verified") === "on",
        };
      }
      if (kind === "expenses")
        payload = {
          date: str("date"),
          category: str("category"),
          classification,
          amount: str("amount"),
          payee: str("payee"),
          description: str("description"),
          method: str("method"),
          bookingId: classification === "direct" ? bookingId : "",
          paid: f.get("paid") === "on",
          notes: str("notes"),
        };
      const serialized = JSON.stringify(payload);
      if (previousInput.current && previousInput.current !== serialized)
        requestKey.current = crypto.randomUUID();
      previousInput.current = serialized;
      const result = await mutate(kind, payload, requestKey.current);
      const file = f.get("attachment");
      if (file instanceof File && file.size) {
        const attachment = new FormData();
        attachment.set("file", file);
        attachment.set("entity", kind === "payments" ? "payment" : "expense");
        attachment.set("entityId", result.id);
        const r = await fetch("/api/attachments", {
          method: "POST",
          body: attachment,
        });
        if (!r.ok) {
          const err = await r.json();
          notify("Record saved. Evidence upload failed: " + err.error, true);
        } else {
          await refresh();
          notify("Record and evidence saved.");
        }
      } else if (kind === "bookings" && result.receipt) {
        const sms = {
          unconfigured: "SMS is not configured.",
          failed: "SMS could not be confirmed.",
          pending: "SMS status is pending.",
          accepted: "SMS accepted by provider.",
        }[
          String(result.sms) as
            "unconfigured" | "failed" | "pending" | "accepted"
        ];
        const email = {
          missing_email: "No email address on the client profile.",
          unconfigured: "Booking email is not configured.",
          failed: "The booking email could not be sent.",
          pending: "Booking email status is pending.",
          accepted: "Booking email accepted for delivery.",
        }[
          String(result.email) as
            "missing_email" | "unconfigured" | "failed" | "pending" | "accepted"
        ];
        try {
          printBookingReceipt(result.receipt);
          notify(["Booking saved.", email, sms].filter(Boolean).join(" "));
        } catch {
          notify(
            ["Booking saved. Open its details to print.", email, sms]
              .filter(Boolean)
              .join(" "),
            true,
          );
        }
      } else notify(record?.id ? "Record updated." : "Record saved.");
      onSaved?.(result);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={titles[kind]}
      subtitle="Verified information in. Clear business records out."
      onClose={() => !busy && onClose()}
      wide={kind === "bookings"}
    >
      <form onSubmit={submit} className="record-form">
        <div className="form-body">
          {kind === "clients" && (
            <>
              <div className="form-grid">
                <label>
                  Full name
                  <input
                    name="name"
                    defaultValue={record?.name}
                    required
                    minLength={2}
                    autoFocus
                  />
                </label>
                <label>
                  Client type
                  <select
                    name="type"
                    defaultValue={record?.type ?? "Individual"}
                  >
                    {["Individual", "Bride", "Model", "Brand", "Corporate"].map(
                      (x) => (
                        <option key={x}>{x}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Phone number
                  <input
                    name="phone"
                    type="tel"
                    defaultValue={record?.phone}
                    placeholder="0300 1234567"
                    required
                  />
                </label>
                <label>
                  WhatsApp number
                  <input
                    name="whatsapp"
                    type="tel"
                    defaultValue={record?.whatsapp}
                    placeholder="Same as phone if blank"
                  />
                </label>
                <label>
                  Email address
                  <input
                    name="email"
                    type="email"
                    defaultValue={record?.email}
                  />
                </label>
                <label>
                  Instagram username
                  <input
                    name="instagram"
                    defaultValue={record?.instagram}
                    placeholder="@yourclient"
                  />
                </label>
              </div>
              <label>
                Address
                <input name="address" defaultValue={record?.address} />
              </label>
              <label>
                Notes
                <textarea name="notes" defaultValue={record?.notes} rows={3} />
              </label>
              <p className="field-hint">
                Phone numbers are normalized and checked for duplicates.
              </p>
            </>
          )}
          {kind === "services" && (
            <>
              <div className="form-grid">
                <label>
                  Service name
                  <input
                    name="name"
                    defaultValue={record?.name}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  Category
                  <select name="category" defaultValue={record?.category}>
                    {CATEGORIES.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Standard price, PKR
                  <input
                    name="price"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={amount(record?.priceMinor)}
                    required
                  />
                </label>
                <label>
                  Duration, minutes
                  <input
                    name="durationMinutes"
                    type="number"
                    min="5"
                    max="1440"
                    defaultValue={record?.durationMinutes ?? 60}
                    required
                  />
                </label>
                <label>
                  Estimated material cost, PKR
                  <input
                    name="estimatedCost"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={amount(record?.estimatedCostMinor)}
                  />
                </label>
              </div>
              <label>
                Description
                <textarea
                  name="description"
                  rows={3}
                  defaultValue={record?.description}
                />
              </label>
              <label className="checkbox">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={record?.active ?? true}
                />
                Available for new bookings
              </label>
              <div className="form-section-head">
                <h3>Sub-services</h3>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() =>
                    setDetails([...details, { name: "", price: "" }])
                  }
                >
                  <Plus size={14} />
                  Add sub-service
                </button>
              </div>
              {details.map((detail, index) => (
                <div className="form-grid" key={detail.id ?? index}>
                  <label>
                    Sub-service name
                    <input
                      required
                      maxLength={160}
                      value={detail.name}
                      onChange={(e) =>
                        setDetails(
                          details.map((row, i) =>
                            i === index
                              ? { ...row, name: e.target.value }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Price, PKR
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      value={detail.price}
                      onChange={(e) =>
                        setDetails(
                          details.map((row, i) =>
                            i === index
                              ? { ...row, price: e.target.value }
                              : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="text-btn danger-text"
                    onClick={() =>
                      setDetails(details.filter((_, i) => i !== index))
                    }
                  >
                    Remove sub-service
                  </button>
                </div>
              ))}
              <p className="field-hint">
                Price changes apply to new booking lines. Existing booking
                prices remain unchanged. Estimates do not become accounting
                expenses.
              </p>
            </>
          )}
          {kind === "bookings" && (
            <>
              <SearchSelect
                label="Client"
                required
                options={d.customers.map((c) => ({
                  id: c.id,
                  label: c.code + " · " + c.name + " · " + c.phone,
                }))}
                value={customerId}
                onChange={setCustomerId}
              />
              <div className="form-grid">
                <label>
                  Appointment date
                  <input
                    type="date"
                    name="appointmentDate"
                    required
                    defaultValue={record?.appointmentDate ?? today()}
                  />
                </label>
                <label>
                  Appointment time
                  <input
                    type="time"
                    name="appointmentTime"
                    required
                    defaultValue={record?.appointmentTime ?? "15:00"}
                  />
                </label>
                {!record?.id && (
                  <label>
                    Initial status
                    <select name="initialStatus">
                      <option value="confirmed">Confirmed appointment</option>
                      <option value="inquiry">
                        Inquiry, awaiting confirmation
                      </option>
                    </select>
                  </label>
                )}
                <label>
                  Booking category
                  <select
                    name="category"
                    defaultValue={record?.category ?? "Bridal"}
                  >
                    {[
                      "Bridal",
                      "Party",
                      "Salon",
                      "Model / Shoot",
                      "Styling",
                      "Other",
                    ].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Makeup artist
                  <input
                    name="artist"
                    defaultValue={record?.artist}
                    placeholder="Artist’s name"
                  />
                </label>
                <label>
                  Hairstylist
                  <input
                    name="hairstylist"
                    defaultValue={record?.hairstylist}
                  />
                </label>
              </div>
              <div className="form-section-head">
                <h3>Services</h3>
              </div>
              {items.map((item, index) => {
                const service = d.services.find(
                  (row) => row.id === item.serviceId,
                );
                const previous = previousLine(item);
                const available: ServiceDetail[] = service?.details ?? [];
                return (
                  <fieldset
                    className="form-grid booking-service-fields"
                    key={item.id ?? index}
                  >
                    <label>
                      Service
                      <select
                        required
                        value={item.serviceId}
                        onChange={(e) =>
                          updateItem(index, {
                            serviceId: e.target.value,
                            detailId: "",
                            customize: false,
                          })
                        }
                      >
                        <option value="">Select a service</option>
                        {d.services
                          .filter(
                            (svc) => svc.active || svc.id === item.serviceId,
                          )
                          .map((svc) => (
                            <option key={svc.id} value={svc.id}>
                              {svc.name}
                            </option>
                          ))}
                        {!service && previous && (
                          <option value={item.serviceId}>
                            {previous.name}
                          </option>
                        )}
                      </select>
                    </label>
                    <label>
                      Qty
                      <input
                        type="number"
                        min="1"
                        max="100"
                        required
                        value={item.quantity}
                        onChange={(e) =>
                          updateItem(index, {
                            quantity: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Customize Service?
                      <select
                        value={item.customize ? "yes" : "no"}
                        disabled={
                          !item.serviceId ||
                          (!available.length && !item.detailId)
                        }
                        onChange={(e) =>
                          updateItem(index, {
                            customize: e.target.value === "yes",
                            detailId: "",
                          })
                        }
                      >
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </select>
                    </label>
                    {item.customize && (
                      <label>
                        Select Service Detail / Sub-Service
                        <select
                          required
                          value={item.detailId}
                          onChange={(e) =>
                            updateItem(index, { detailId: e.target.value })
                          }
                        >
                          <option value="">Select a sub-service</option>
                          {available.map((detail) => (
                            <option key={detail.id} value={detail.id}>
                              {detail.name} · {formatMoney(detail.priceMinor)}
                            </option>
                          ))}
                          {previous?.detailName &&
                            !available.some(
                              (detail) => detail.id === item.detailId,
                            ) && (
                              <option value={item.detailId}>
                                {previous.detailName}
                              </option>
                            )}
                        </select>
                      </label>
                    )}
                    <label>
                      Price, PKR
                      <input value={amount(linePrice(item))} readOnly />
                    </label>
                    <label>
                      Booking-only description
                      <input
                        maxLength={160}
                        value={item.customName}
                        onChange={(e) =>
                          updateItem(index, { customName: e.target.value })
                        }
                        placeholder="Optional note"
                      />
                    </label>
                    {items.length > 1 && (
                      <button
                        type="button"
                        className="text-btn danger-text"
                        onClick={() =>
                          setItems(items.filter((_, i) => i !== index))
                        }
                      >
                        Remove line
                      </button>
                    )}
                  </fieldset>
                );
              })}
              <div className="form-totals">
                <label>
                  Discount, PKR
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                  />
                </label>
                <div>
                  <span>Net booking value</span>
                  <strong>{formatMoney(netMinor)}</strong>
                </div>
                {record?.id && (
                  <div>
                    <span>Remaining balance</span>
                    <strong>{formatMoney(netMinor - record.collected)}</strong>
                  </div>
                )}
              </div>
              {!record?.id && (
                <>
                  <div className="form-section-head">
                    <h3>Payment</h3>
                  </div>
                  <div className="form-grid">
                    <label>
                      Payment Method
                      <select
                        required
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                      >
                        <option value="">Select a payment method</option>
                        {BOOKING_PAYMENT_METHODS.map((method) => (
                          <option key={method} value={method}>
                            {BOOKING_PAYMENT_LABELS[method]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Advance Paid, PKR
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={advance}
                        onChange={(e) => setAdvance(e.target.value)}
                      />
                    </label>
                    <label>
                      Remaining, PKR
                      <input readOnly value={amount(netMinor - advanceMinor)} />
                    </label>
                  </div>
                  {paymentMethod === "Bank transfer" && d.config.bankQrUrl && (
                    <a
                      className="text-btn"
                      href={d.config.bankQrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open bank transfer QR code
                    </a>
                  )}
                </>
              )}
              <label>
                Booking notes
                <textarea name="notes" rows={2} defaultValue={record?.notes} />
              </label>
              {record?.id && (
                <label>
                  Reason for this change
                  <textarea name="reason" required minLength={5} rows={2} />
                </label>
              )}
            </>
          )}
          {(kind === "payments" || kind === "expenses") && (
            <>
              <div className="form-grid">
                <label>
                  Transaction date
                  <input
                    name="date"
                    type="date"
                    required
                    max={today()}
                    defaultValue={today()}
                  />
                </label>
                <label>
                  Amount, PKR
                  <input
                    name="amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    autoFocus
                  />
                </label>
                <label>
                  Payment method
                  <select name="method">
                    {METHODS.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </label>
                {kind === "expenses" && (
                  <label>
                    Classification
                    <select
                      value={classification}
                      onChange={(e) => setClassification(e.target.value)}
                    >
                      <option value="overhead">Operating overhead</option>
                      <option value="direct">Direct booking cost</option>
                      <option value="capital">Capital equipment</option>
                    </select>
                  </label>
                )}
              </div>
              {(kind === "payments" || classification === "direct") && (
                <SearchSelect
                  label="Related booking"
                  required
                  options={d.bookings
                    .filter(
                      (b) =>
                        kind === "expenses" ||
                        (!["cancelled", "no_show"].includes(b.status) &&
                          b.outstanding > 0),
                    )
                    .map((b) => ({
                      id: b.id,
                      label:
                        b.code +
                        " · " +
                        b.clientName +
                        " · " +
                        formatMoney(b.outstanding) +
                        " outstanding",
                    }))}
                  value={bookingId}
                  onChange={setBookingId}
                />
              )}{" "}
              {kind === "payments" && (
                <>
                  <div className="notice">
                    {selectedBooking ? (
                      <span>
                        Outstanding:{" "}
                        <strong>
                          {formatMoney(selectedBooking.outstanding)}
                        </strong>
                        .{" "}
                        {selectedBooking.status === "completed"
                          ? "Posted to customer receivables."
                          : "Held as an advance until services are completed."}
                      </span>
                    ) : (
                      "Choose a booking to see its balance."
                    )}
                  </div>
                  <label>
                    Bank / payment reference
                    <input name="reference" />
                  </label>
                  <label className="checkbox">
                    <input name="verified" type="checkbox" defaultChecked />I
                    have verified this payment
                  </label>
                  <p className="field-hint">
                    Unverified reports are stored for review and do not change
                    the ledger or customer balance.
                  </p>
                </>
              )}
              {kind === "expenses" && (
                <>
                  <div className="form-grid">
                    <label>
                      Category
                      <select name="category" defaultValue={record?.category}>
                        {(record?.category === "Salaries"
                          ? ["Salaries"]
                          : EXPENSE_CATEGORIES
                        ).map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Paid to / supplier
                      <input name="payee" required minLength={2} />
                    </label>
                  </div>
                  <label>
                    Description
                    <input name="description" required minLength={3} />
                  </label>
                  <label className="checkbox">
                    <input name="paid" type="checkbox" defaultChecked />
                    Already paid in full
                  </label>
                  <p className="field-hint">
                    Unpaid expenses create a supplier liability. Capital
                    equipment is excluded from operating expenses. Inventory
                    purchases will use the inventory module in the next release.
                  </p>
                </>
              )}
              <label>
                Notes
                <textarea name="notes" rows={2} />
              </label>
              <label>
                Receipt / evidence, optional
                <input
                  name="attachment"
                  type="file"
                  accept="image/png,image/jpeg,application/pdf"
                />
                <span className="field-hint">
                  PNG, JPEG, or PDF. Maximum 3 MB.
                </span>
              </label>
            </>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            {busy
              ? "Saving…"
              : "Save " +
                {
                  clients: "client",
                  services: "service",
                  bookings: "booking",
                  payments: "payment",
                  expenses: "expense",
                }[kind]}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
export type ActionSpec = {
  title: string;
  description: string;
  endpoint: string;
  input: any;
  fields?: ("amount" | "method" | "reason" | "date")[];
  warning?: string;
};
export function ActionForm({
  spec,
  onClose,
}: {
  spec: ActionSpec;
  onClose: () => void;
}) {
  const { mutate, notify } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const previousInput = useRef("");
  return (
    <Modal
      title={spec.title}
      subtitle={spec.description}
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          const input = { ...spec.input };
          for (const field of spec.fields ?? [])
            input[field] = String(f.get(field));
          try {
            const serialized = JSON.stringify(input);
            if (previousInput.current && previousInput.current !== serialized)
              key.current = crypto.randomUUID();
            previousInput.current = serialized;
            await mutate(spec.endpoint, input, key.current);
            notify("Transaction recorded. Audit history updated.");
            onClose();
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="form-body">
          {spec.warning && <div className="notice warning">{spec.warning}</div>}
          {spec.fields?.includes("date") && (
            <label>
              Effective date
              <input
                name="date"
                type="date"
                max={today()}
                required
                defaultValue={spec.input.date ?? today()}
              />
            </label>
          )}
          {spec.fields?.includes("amount") && (
            <label>
              Amount, PKR
              <input
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </label>
          )}
          {spec.fields?.includes("method") && (
            <label>
              Payment method
              <select name="method" defaultValue={spec.input.method ?? "Cash"}>
                {METHODS.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          )}
          {spec.fields?.includes("reason") && (
            <label>
              Reason / verification notes
              <textarea
                name="reason"
                minLength={5}
                maxLength={1000}
                required
                rows={3}
              />
            </label>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Recording…" : "Confirm & record"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
