export interface NavItem {
  label: string;
  to: string;
  group: "Operate" | "Govern" | "Configure";
}

export const NAV_ITEMS: NavItem[] = [
  // Feature units append their own entry here, one object literal per line, e.g.:
  // { label: "Machines", to: "/machines", group: "Operate" },
];
