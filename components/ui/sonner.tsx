"use client";

import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Terminal-styled toasts. The shadcn default followed next-themes, but no
 * ThemeProvider is mounted, so it fell back to "system" and rendered white,
 * rounded, sans-serif cards on a black terminal. Styling is in `.bb-toast`
 * (styles/globals.css); a caller can colour the left rule with the
 * `--bb-toast-rule` CSS variable (useAlertNotifications does, per severity).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      gap={6}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "bb-toast",
          title: "bb-toast-title",
          description: "bb-toast-desc",
          actionButton: "bb-toast-action",
          cancelButton: "bb-toast-cancel",
          icon: "bb-toast-icon",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
