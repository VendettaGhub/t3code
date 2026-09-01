import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: persistenceMocks,
  }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
  updateClientSettingsDurably,
} from "./useSettings";

beforeEach(() => {
  persistenceMocks.getClientSettings.mockReset();
  persistenceMocks.setClientSettings.mockReset();
  persistenceMocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  persistenceMocks.setClientSettings.mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });

  it("keeps server settlement settings when legacy client data contains retired keys", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarAutoSettleAfterDays: 14,
      sidebarAutoSettleOnMerge: false,
    };
    const legacyClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAutoSettleAfterDays: 1,
      sidebarAutoSettleOnMerge: true,
    };

    const settings = mergeEnvironmentSettings(serverSettings, legacyClientSettings);

    expect(settings.sidebarAutoSettleAfterDays).toBe(14);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
  });
});

describe("updateClientSettingsDurably", () => {
  it("preserves hydrated settings and waits for persistence", async () => {
    let resolveWrite: () => void = () => undefined;
    persistenceMocks.setClientSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const existingSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_work"),
          model: "gpt-5.6",
        },
      ],
    };
    __setClientSettingsForTests(existingSettings);

    const write = updateClientSettingsDurably({
      onboardingCompletedAt: "2026-09-01T12:00:00.000Z",
    });
    let settled = false;
    void write.then(() => {
      settled = true;
    });

    expect(getClientSettings()).toEqual({
      ...existingSettings,
      onboardingCompletedAt: "2026-09-01T12:00:00.000Z",
    });
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledWith(getClientSettings());
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveWrite();
    await expect(write).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("rejects failed writes and can retry the optimistic settings", async () => {
    const writeError = new Error("Storage is full");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    persistenceMocks.setClientSettings.mockRejectedValueOnce(writeError);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "24-hour",
    });

    const patch = { onboardingCompletedAt: "2026-09-01T12:00:00.000Z" };
    await expect(updateClientSettingsDurably(patch)).rejects.toBe(writeError);

    expect(getClientSettings()).toMatchObject({
      timestampFormat: "24-hour",
      onboardingCompletedAt: patch.onboardingCompletedAt,
    });
    await expect(updateClientSettingsDurably(patch)).resolves.toBeUndefined();
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
