import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PACKAGE_SETTINGS,
  PACKAGE_SETTING_LABELS,
  type PackageSetting,
  settingUnavailableReason,
} from "@/lib/package-setting";
import { cn } from "@/lib/utils";

/**
 * Picks a package's setting: Allowed, Ensure installed, or Ensure latest
 * version. Options the entry cannot take are shown disabled with the reason,
 * rather than hidden, so the person sees why.
 */
export function PackageSettingSelect({
  id,
  value,
  onChange,
  packageName,
  versionPin,
  disabled,
  className,
}: {
  id?: string;
  value: PackageSetting;
  onChange: (next: PackageSetting) => void;
  packageName: string;
  versionPin: string | null;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as PackageSetting)}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <SelectTrigger
        {...(id !== undefined ? { id } : {})}
        className={cn("h-8 w-48 text-xs", className)}
        aria-label="Package setting"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PACKAGE_SETTINGS.map((setting) => {
          const reason =
            setting === value
              ? null
              : settingUnavailableReason(setting, { packageName, versionPin });
          return (
            <SelectItem key={setting} value={setting} disabled={reason !== null}>
              {PACKAGE_SETTING_LABELS[setting]}
              {reason && <span className="ml-1.5 text-xs text-muted-foreground">({reason})</span>}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
