export interface NavItem {
  label: string;
  to: string;
  group: "Operate" | "Govern" | "Configure";
}

export const NAV_ITEMS: NavItem[] = [{ label: "Machines", to: "/machines", group: "Operate" }];
