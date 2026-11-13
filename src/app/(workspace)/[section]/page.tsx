import { getActor } from "@/server/auth";
import { notFound } from "next/navigation";
import { Screen } from "@/components/screens";
const sections = [
  "dashboard",
  "clients",
  "bookings",
  "services",
  "payments",
  "expenses",
  "reports",
  "inventory",
  "stock",
  "retail",
  "salaries",
  "audit",
  "settings",
];
export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!sections.includes(section)) notFound();
  const actor = await getActor();
  if (
    actor?.role === "receptionist" &&
    !["dashboard", "clients", "bookings"].includes(section)
  )
    notFound();
  return <Screen section={section} />;
}
