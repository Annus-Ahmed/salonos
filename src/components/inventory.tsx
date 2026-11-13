"use client";

import { useRef, useState, type FormEvent } from "react";
import { METHODS, today } from "@/lib/domain";
import { REPORTS, reportRows } from "@/lib/reporting";
import { DataTable, Modal, PageHeading } from "./ui";
import { useWorkspace } from "./workspace";

type Section = "inventory" | "stock" | "retail";

export function Inventory({ section }: { section: Section }) {
  const { data, actor, mutate, notify } = useWorkspace();
  const [form, setForm] = useState<
    "product" | "purchase" | "usage" | "retail" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ input: string; key: string } | null>(null);
  const products = data?.products ?? [];
  const rows = reportRows(data!, section, "0001-01-01", today());
  const columns = Object.keys(rows[0] ?? {}).map((key) => ({
    key,
    label: key,
  }));
  function open(value: NonNullable<typeof form>) {
    setError("");
    request.current = null;
    setForm(value);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !form) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const payload = form === "product" ? fields : { ...fields, kind: form };
    const input = JSON.stringify(payload);
    if (request.current?.input !== input)
      request.current = { input, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await mutate(
        form === "product" ? "products" : "stock",
        payload,
        request.current.key,
      );
      notify("Record saved.");
      setForm(null);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title={REPORTS[section]}
        description={
          section === "inventory"
            ? "Review products, quantities, and stock value."
            : section === "stock"
              ? "Review purchases, product usage, and sales."
              : "Review paid product sales."
        }
      >
        {actor.role === "finance_manager" && (
          <>
            {section === "inventory" && (
              <button className="btn primary" onClick={() => open("product")}>
                Add product
              </button>
            )}
            {section === "stock" && (
              <>
                <button
                  className="btn primary"
                  disabled={!products.length}
                  onClick={() => open("purchase")}
                >
                  Record purchase
                </button>
                <button
                  className="btn"
                  disabled={!products.length}
                  onClick={() => open("usage")}
                >
                  Record usage
                </button>
              </>
            )}
            {section === "retail" && (
              <button
                className="btn primary"
                disabled={!products.length}
                onClick={() => open("retail")}
              >
                Record sale
              </button>
            )}
          </>
        )}
      </PageHeading>
      <section className="panel">
        <DataTable rows={rows} columns={columns} />
      </section>
      {form && (
        <Modal
          title={
            {
              product: "Add product",
              purchase: "Record paid stock purchase",
              usage: "Record stock usage",
              retail: "Record paid retail sale",
            }[form]
          }
          onClose={() => !busy && setForm(null)}
        >
          <form onSubmit={save}>
            <div className="form-body">
              {form === "product" ? (
                <>
                  <label>
                    SKU
                    <input name="sku" required maxLength={160} />
                  </label>
                  <label>
                    Product name
                    <input name="name" required maxLength={160} />
                  </label>
                  <label>
                    Standard retail price per unit (PKR)
                    <input
                      name="retailPrice"
                      type="number"
                      min="0"
                      step="0.01"
                      required
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Product
                    <select name="productId" required defaultValue="">
                      <option value="" disabled>
                        Choose a product
                      </option>
                      {products.map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name} ({p.units} on hand, PKR{" "}
                          {p.retailPriceMinor / 100} per unit)
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Date
                    <input
                      type="date"
                      name="date"
                      defaultValue={today()}
                      max={today()}
                      required
                    />
                  </label>
                  <label>
                    Quantity
                    <input
                      type="number"
                      name="quantity"
                      min="1"
                      max="100000"
                      required
                    />
                  </label>
                  {form === "usage" ? (
                    <input type="hidden" name="method" value="Other" />
                  ) : (
                    <>
                      <label>
                        Total amount (PKR)
                        <input
                          name="amount"
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                        />
                      </label>
                      <label>
                        Payment method
                        <select name="method">
                          {METHODS.map((method) => (
                            <option key={method}>{method}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <label>
                    Notes
                    <textarea name="note" maxLength={4000} />
                  </label>
                </>
              )}
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn primary" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
