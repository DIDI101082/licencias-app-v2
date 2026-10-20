// PARCHE para lib/menu.ts
// Agregar FortiClient EMS al tema "perimetro"
//
// BUSCAR esta línea (la del FortiGate):
//     { href: "/red/fortigate", label: "FortiGate" },
//
// REEMPLAZAR por:
//     { href: "/red/fortigate", label: "FortiGate" },
//     { href: "/red/forti-ems", label: "FortiClient EMS" },
//
// Eso es todo. Una sola línea agregada.
