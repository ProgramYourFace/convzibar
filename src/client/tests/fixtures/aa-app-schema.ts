import { createZbarSchema, materialize } from "../../index";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// The app's access graph (docs/specs/zbar-schema-proposal.md §2; the engine
// grammar is convex/components/convzibar/CONTRACT.md §2).
//
// The seat (`system_user`) is the only subject: roles, group memberships and
// direct grants are facts held by a seat, and every check runs as the caller's
// seat (convex/zbar.ts `requireMe`). Every resource is system-parented.
//
// A containment (group or direct seat grant) is ONE fact at its tier: on a
// resource, `operator ⊇ admin` and `viewer ⊇ operator`, and an `expands` arm's
// first hop reads the facts of its relation and of every relation it inherits,
// so a group written at `admin` is also expanded on `operator` and `viewer`
// (convex/lib/containment.ts).
//
// Every arm is computed at read time except `notification_rule.source`'s two
// expansions, which the hot ingest path (`rulesForDevice`) reads as one range.
// ---------------------------------------------------------------------------

export const schema = createZbarSchema()
  // A rule recipient resolved per alert from the device's context (today: the
  // device's assigned person), never a fixed seat. Ids are `${systemId}:${kind}`
  // (lib/notifications/linked.ts).
  .entity("linked_recipient")

  .entity("system", (e) =>
    e
      .relation("owner", "system_user")
      .relation("admin", "owner", "system_user")
      .relation("viewer", "admin", "system_user")
      // Every seat, by its parent fact; no tuple.
      .relation("member", "~system_user#parent")
      // Every device, by its parent fact; no rows. `notification_rule.source`
      // materializes it for a rule sourced from the whole system.
      .relation("devices", "~device#parent")
      .permission("view", "viewer")
      .permission("view_as_member", "member")
      .permission("manage_resources", "admin")
      .permission("manage_members", "admin")
      .permission("manage_owners", "owner")
      .permission("manage", "owner")
      .permission("configure_as_recipient", "admin"),
  )

  .entity("group", (e) =>
    e
      .relation("parent", "system")
      .relation("admin", "system_user")
      // The members.
      .relation("viewer", "admin", "system_user")
      // What the group contains: the resources on which it holds a tier.
      .relation(
        "devices",
        "~device#admin",
        "~device#operator",
        "~device#viewer",
      )
      .relation("seats", "~system_user#admin", "~system_user#viewer")
      // System roles reach every group through the permission, not the relation,
      // so `group#viewer` elsewhere expands to members only.
      .permission("view", "viewer", "parent.viewer")
      .permission("manage", "admin", "parent.admin")
      .permission("manage_members", "admin", "parent.admin")
      .permission("configure_as_recipient", "admin", "parent.admin"),
  )

  .entity("device", (e) =>
    e
      .relation("parent", "system")
      .relation("admin", "system_user", "group#admin", "parent.admin")
      // The driver tier: view + assign to yourself. System viewers do not operate.
      .relation("operator", "admin", "system_user", "group#viewer")
      .relation(
        "viewer",
        "operator",
        "system_user",
        "group#viewer",
        "parent.viewer",
      )
      .permission("view", "viewer")
      .permission("operate", "operator")
      .permission("manage", "admin"),
  )

  .entity("geofence", (e) =>
    e
      .relation("parent", "system")
      .relation("admin", "system_user", "group#admin", "parent.admin")
      .relation(
        "viewer",
        "admin",
        "system_user",
        "group#viewer",
        "parent.viewer",
      )
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )

  .entity("system_user", (e) =>
    e
      .relation("parent", "system")
      // (seat, self, seat): written by `linkSeatToSystem` (convex/lib/perm.ts),
      // so every seat views its own profile.
      .relation("self", "system_user")
      .relation("admin", "system_user", "group#admin", "parent.admin")
      .relation(
        "viewer",
        "admin",
        "self",
        "system_user",
        "group#viewer",
        "parent.viewer",
      )
      .permission("view", "viewer")
      .permission("manage", "admin")
      // Granting view is the consent to address.
      .permission("configure_as_recipient", "viewer"),
  )

  .entity("notification_rule", (e) =>
    e
      .relation("parent", "system")
      // Hot: `rulesForDevice` reads (D, source, R) in one range per device per batch.
      .relation(
        "source",
        "device",
        materialize("group#devices"),
        materialize("system#devices"),
      )
      // Cold: the audience is re-expanded at fire time; computed.
      .relation(
        "recipient",
        "system_user",
        "linked_recipient",
        "group#seats",
        "system#member",
      )
      .properties("recipient", {
        email: v.optional(v.boolean()),
        sms: v.optional(v.boolean()),
        push: v.optional(v.boolean()),
        // Named edges only: tell this recipient only when no linked person
        // was reached for the alert (lib/notifications/audience.ts).
        fallback: v.optional(v.boolean()),
      })
      // Access does not flow through source or recipient: those are data flow.
      .relation("admin", "system_user", "group#admin", "parent.admin")
      .relation(
        "viewer",
        "admin",
        "system_user",
        "group#viewer",
        "parent.viewer",
      )
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )

  // A Charts dashboard. Viewing is shareable (group or seat); authoring is
  // system-admin only: it is arbitrary warehouse queries over the whole system.
  .entity("dashboard", (e) =>
    e
      .relation("parent", "system")
      .relation("viewer", "system_user", "group#viewer", "parent.viewer")
      .permission("view", "viewer")
      .permission("manage", "parent.admin"),
  )
  .build();

export type Schema = typeof schema;
