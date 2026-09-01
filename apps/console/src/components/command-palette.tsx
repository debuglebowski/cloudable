import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { listMachines, machinesKeys } from "@/api/machines";
import { listPeople, peopleKeys } from "@/api/people";
import { OsIcon } from "@/components/os-icon";
import { PersonAvatar } from "@/components/person-avatar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { NAV_ITEMS } from "@/nav-config";

import { ARCHIVED_MACHINE_STATES, MACHINE_STATE_LABEL } from "@/routes/machines/machine-state";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Global Cmd/Ctrl+K palette: jump to any nav page, search machines by name and go
 * straight to a machine's detail page, or search people by email (lands on /people —
 * see the People group's own comment below for why). Controlled from `RootLayout`
 * (root.tsx) so both the keyboard shortcut and the visible sidebar search button open
 * the same instance.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();

  const { data: machines } = useQuery({
    queryKey: machinesKeys.list(),
    queryFn: listMachines,
    enabled: open,
  });
  const { data: people } = useQuery({
    queryKey: peopleKeys.list(),
    queryFn: listPeople,
    enabled: open,
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  // NAV_ITEMS.to is a plain string, not a statically-known route literal (same
  // reason root.tsx renders nav links as plain <a> tags instead of typed <Link>),
  // so this goes through the router's imperative navigate rather than fighting
  // the typed `to` union for a runtime value.
  function goTo(path: string) {
    onOpenChange(false);
    navigate({ to: path });
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search machines, people, or jump to a page…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Go to">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem key={item.to} value={item.label} onSelect={() => goTo(item.to)}>
                {/* Same fixed identity color as the sidebar (see nav-config.ts) —
                    Machines/People stay recognizable here too, not flattened to
                    the item's default icon color. */}
                <Icon className={item.iconColorClassName} />
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
        {machines && machines.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Machines">
              {machines
                .filter((machine) => !ARCHIVED_MACHINE_STATES.has(machine.state))
                .map((machine) => (
                  <CommandItem
                    key={machine.id}
                    value={machine.name}
                    onSelect={() => goTo(`/machines/${machine.id}`)}
                  >
                    {/* Same leading identity icon as the Machines table's own Name
                        column (and this group's People sibling, via PersonAvatar) —
                        a machine result shouldn't be the one place in this list
                        that lost its icon. */}
                    <OsIcon image={machine.image} className="size-4 shrink-0" />
                    <span>{machine.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {MACHINE_STATE_LABEL[machine.state]}
                    </span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </>
        )}
        {people && people.length > 0 && (
          <>
            <CommandSeparator />
            {/* People has no per-person detail route (it's a flat, fully-editable table,
                not individually addressable pages) — every match lands on /people rather
                than a specific record, same as clicking "People" under Go to. Still useful:
                it's a fast "is there a person named X" check that jumps straight there. */}
            <CommandGroup heading="People">
              {people.map((person) => (
                <CommandItem key={person.id} value={person.email} onSelect={() => goTo("/people")}>
                  <PersonAvatar name={person.email} className="size-4" />
                  <span>{person.email}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {person.active ? "Active" : "Deactivated"}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
