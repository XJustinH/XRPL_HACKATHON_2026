import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Storage for Spotify connections (XRPL-092). Server-only.
 * Token columns only ever hold sealed values (see ./secret-box.ts); this layer never sees plaintext.
 */

export type StoredSpotifyConnection = {
  userId: string;
  spotifyUserId: string | null;
  spotifyDisplayName: string | null;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: Date;
  scope: string;
};

export type SealedTokens = Pick<StoredSpotifyConnection, "accessTokenEnc" | "refreshTokenEnc" | "accessTokenExpiresAt">;

export interface SpotifyConnectionStore {
  find(userId: string): Promise<StoredSpotifyConnection | null>;
  /** Creates the user's connection, or replaces it. */
  save(connection: StoredSpotifyConnection): Promise<void>;
  /**
   * Stores refreshed tokens, but only over the version they were refreshed from
   * (`replacingRefreshTokenEnc`). False if the connection was removed or replaced meanwhile,
   * so a slow refresh can never bring back a connection the user just disconnected.
   */
  updateTokens(userId: string, replacingRefreshTokenEnc: string, next: SealedTokens): Promise<boolean>;
  /** Deletes the connection. With `onlyIfRefreshTokenEnc`, only that exact version. */
  remove(userId: string, onlyIfRefreshTokenEnc?: string): Promise<void>;
}

export class PrismaSpotifyStore implements SpotifyConnectionStore {
  constructor(private readonly db: Pick<PrismaClient, "spotifyConnection">) {}

  async find(userId: string): Promise<StoredSpotifyConnection | null> {
    return this.db.spotifyConnection.findUnique({
      where: { userId },
      select: {
        userId: true,
        spotifyUserId: true,
        spotifyDisplayName: true,
        accessTokenEnc: true,
        refreshTokenEnc: true,
        accessTokenExpiresAt: true,
        scope: true,
      },
    });
  }

  async save(connection: StoredSpotifyConnection): Promise<void> {
    const { userId, ...data } = connection;
    await this.db.spotifyConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }

  async updateTokens(userId: string, replacingRefreshTokenEnc: string, next: SealedTokens): Promise<boolean> {
    const { count } = await this.db.spotifyConnection.updateMany({
      where: { userId, refreshTokenEnc: replacingRefreshTokenEnc },
      data: next,
    });
    return count > 0;
  }

  async remove(userId: string, onlyIfRefreshTokenEnc?: string): Promise<void> {
    await this.db.spotifyConnection.deleteMany({
      where: { userId, ...(onlyIfRefreshTokenEnc ? { refreshTokenEnc: onlyIfRefreshTokenEnc } : {}) },
    });
  }
}
