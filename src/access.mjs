import { id, now, date, number, expired, fail } from "./core.mjs";

// Account grants belong to Node metadata; the shared file remains owned by its author.
export class Access {
  constructor(store, catalog) {
    Object.assign(this, { store, catalog });
  }
  live(g) {
    return !g.revokedAt && !expired(g.expiresAt);
  }
  public(g) {
    const user = this.store.get("users", g.granteeUserId);
    return {
      id: g.id,
      fileId: g.fileId,
      ownerId: Number(g.ownerId),
      granteeUserId: Number(g.granteeUserId),
      granteeDisplayName: user?.displayName,
      granteeUsername: user?.username,
      permission: g.permission,
      expiresAt: g.expiresAt,
      createdAt: g.createdAt,
    };
  }
  get(ownerId, grantId) {
    const g = this.store.get("grants", grantId);
    if (!g || g.ownerId !== String(ownerId) || g.revokedAt) fail(404, "grant_not_found");
    return g;
  }
  create(ownerId, fileId, body) {
    this.catalog.get(ownerId, fileId, true);
    const granteeUserId = String(number(body.granteeUserId, 1)),
      user = this.store.get("users", granteeUserId);
    if (!user || user.disabled) fail(404, "user_not_found");
    if (granteeUserId === String(ownerId)) fail(422, "cannot_share_with_owner");
    const permission = body.permission ?? "read";
    if (!["read", "edit"].includes(permission)) fail(422, "invalid_permission");
    const expiresAt = body.expiresAt === undefined ? undefined : date(body.expiresAt);
    const old = this.store
      .list("grants", String(ownerId))
      .find((g) => g.fileId === fileId && g.granteeUserId === granteeUserId && this.live(g));
    const grant = {
      ...old,
      id: old?.id || id(),
      ownerId: String(ownerId),
      fileId,
      granteeUserId,
      permission,
      expiresAt,
      createdAt: old?.createdAt || now(),
    };
    this.store.put("grants", grant);
    return this.public(grant);
  }
  update(ownerId, grantId, body) {
    const g = this.get(ownerId, grantId);
    this.catalog.get(ownerId, g.fileId, true);
    if (body.permission !== undefined) {
      if (!["read", "edit"].includes(body.permission)) fail(422, "invalid_permission");
      g.permission = body.permission;
    }
    if (body.clearExpiresAt) delete g.expiresAt;
    else if (body.expiresAt !== undefined) g.expiresAt = date(body.expiresAt);
    this.store.put("grants", g);
    return this.public(g);
  }
  authorize(userId, fileId, write = false, active = true) {
    const file = this.store.get("files", fileId),
      actor = String(userId);
    if (!file || file._legacyRoot) fail(404, "file_not_found");
    if (!(file.ownerId === actor && !active) && !this.catalog.isActive(file.ownerId, file))
      fail(404, "file_not_found");
    if (file.ownerId === actor) return file;
    if (this.store.get("users", file.ownerId)?.disabled) fail(404, "file_not_found");
    const ancestors = new Set();
    let current = file;
    while (current && !ancestors.has(current.id)) {
      ancestors.add(current.id);
      current = current.parentId ? this.store.get("files", current.parentId) : undefined;
    }
    const grants = this.store
      .list("grants", file.ownerId)
      .filter((g) => g.granteeUserId === actor && this.live(g));
    // Quarantine of a received root also blocks access through another ancestor grant.
    if (grants.some((g) => g.spamAt && ancestors.has(g.fileId))) fail(404, "file_not_found");
    const allowed = grants.some(
      (g) => ancestors.has(g.fileId) && (!write || g.permission === "edit"),
    );
    if (!allowed) fail(404, "file_not_found");
    return file;
  }
  incoming(userId, spam = false) {
    const entries = new Map();
    for (const g of this.store
      .list("grants")
      .filter(
        (g) => g.granteeUserId === String(userId) && this.live(g) && Boolean(g.spamAt) === spam,
      )) {
      const file = this.store.get("files", g.fileId);
      if (
        !file ||
        this.store.get("users", file.ownerId)?.disabled ||
        !this.catalog.isActive(file.ownerId, file)
      )
        continue;
      const previous = entries.get(file.id);
      entries.set(file.id, {
        file: this.catalog.public(file),
        permission: previous?.permission === "edit" ? "edit" : g.permission,
      });
    }
    return [...entries.values()].sort((a, b) => a.file.name.localeCompare(b.file.name));
  }
  quarantine(userId, fileId, action) {
    const grants = this.store
      .list("grants")
      .filter((g) => g.granteeUserId === String(userId) && g.fileId === fileId && this.live(g));
    if (!grants.length) fail(404, "grant_not_found");
    this.store.transaction(() => {
      for (const g of grants) {
        if (action === "dismiss") g.revokedAt = now();
        else if (action === "restore") delete g.spamAt;
        else g.spamAt = now();
        this.store.put("grants", g);
      }
    });
  }
}
