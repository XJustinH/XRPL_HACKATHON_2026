import type { UserRole } from "@/contracts";

export const ROLE_LABEL: Record<UserRole, string> = {
  CUSTOMER: "Customer",
  SELLER: "Seller",
  ORGANISER: "Organiser",
};

/** Where each role lands after signing in or onboarding. */
export const ROLE_HOME: Record<UserRole, string> = {
  CUSTOMER: "/",
  SELLER: "/seller/events",
  ORGANISER: "/seller/events",
};
