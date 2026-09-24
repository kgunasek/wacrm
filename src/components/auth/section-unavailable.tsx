"use client";

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Shown in place of a section whose nav entry is hidden for this role.
 *
 * The sidebar already omits these links, so anyone seeing this arrived
 * by a bookmark, a shared URL, or the browser's history. Without it the
 * page rendered normally and then failed piecemeal as each fetch came
 * back 403 — this says plainly that the section isn't theirs, and points
 * them at the person who can change that.
 */
export function SectionUnavailable() {
  const t = useTranslations("AccountAccess");

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
        <Lock className="h-5 w-5 text-muted-foreground" />
      </div>
      <h1 className="mt-4 text-base font-semibold text-foreground">
        {t("sectionUnavailableTitle")}
      </h1>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        {t("sectionUnavailableBody")}
      </p>
    </div>
  );
}
