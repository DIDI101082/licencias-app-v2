import { redirect } from "next/navigation";

// Los tickets pasaron a la solapa HelpDesk
export default function TicketsMovido() {
  redirect("/helpdesk");
}
