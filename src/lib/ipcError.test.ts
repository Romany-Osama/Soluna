import { describe, expect, it } from "vitest";
import { ipcErrorMessage, isIpcError, isIpcErrorCode, isRetryable, toIpcError } from "./ipcError";
import { errorMessage, noticeSummary } from "./util";

describe("ipcError", () => {
  const structured = { code: "network", message: "visitorData request failed", retryable: true };

  it("recognises the backend shape and rejects look-alikes", () => {
    expect(isIpcError(structured)).toBe(true);
    expect(isIpcError({ ...structured, code: "teapot" })).toBe(false);
    expect(isIpcError({ code: "network", message: "x" })).toBe(false);
    expect(isIpcError("network")).toBe(false);
    expect(isIpcError(null)).toBe(false);
  });

  it("normalises strings, Errors and unknown values", () => {
    expect(toIpcError("invalid args `videoId` for command `ytm_player`: bad").code).toBe("invalid_argument");
    expect(toIpcError("Backup cancelled").code).toBe("cancelled");
    expect(toIpcError(new Error("boom"))).toEqual({ code: "internal", message: "boom", retryable: false });
    expect(toIpcError(42).message).toBe("Unexpected error");
  });

  it("exposes code, retry and message helpers", () => {
    expect(isRetryable(structured)).toBe(true);
    expect(isRetryable("plain")).toBe(false);
    expect(isIpcErrorCode({ code: "cancelled", message: "Backup cancelled", retryable: false }, "cancelled")).toBe(
      true,
    );
    expect(ipcErrorMessage({ ...structured, detail: "offline" })).toBe("visitorData request failed (offline)");
  });

  it("errorMessage never renders [object Object] for structured errors", () => {
    expect(errorMessage(structured)).toBe("visitorData request failed");
    expect(errorMessage("plain text")).toBe("plain text");
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
});

describe("restore failure detail reaches the user", () => {
  // NOTE, stated plainly: this describe block is a FORMATTER test. The
  // `outcomes` below are hard-coded strings copied from
  // `failed_restore_outcome` / `rollback_failure_outcome` in
  // src-tauri/src/ipc/backup.rs — they are NOT read from the backend and
  // nothing here executes the Rust code. What this proves is that IF the
  // backend sends these exact strings, the notice the user sees (via
  // `errorMessage` + `noticeSummary`) already states (a), (b) and (c) in
  // its visible prefix. The backend-to-notice integration proof is the
  // Rust boundary test `restore_failure_ipc_error_carries_outcome_as_detail`
  // (serialized IPC error → message/detail after sanitize) together with
  // the `errorMessage` assertions in this file. Do not cite this block as
  // proof that the backend produces these outcomes.
  // Must match `failed_restore_outcome` / `rollback_failure_outcome` in
  // src-tauri/src/ipc/backup.rs; if the Rust wording changes, update these.
  // Each pair is (summary, outcome) as the backend sends them over IPC: the
  // summary is the IpcError message, the outcome is the detail. The settings
  // screen shows `Backup could not be restored: ${errorMessage(error)}`. The
  // `claims` are what the visible notice prefix must already say without
  // hovering (see the visible-prefix test below): (a) whether the restore
  // became active, (b) whether the previous library is usable and in use,
  // (c) whether a restart or retry is needed. The summaries below are the
  // pairings each branch produces — migration (41 chars) for variants 1, 2
  // and 5, reopen (31) for variants 3 and 4 — but the migration summary can
  // pair with ANY outcome: the migration branch's rollback selects the
  // outcome, so variants 3 and 4 occur with the migration summary too. The
  // migration summary is therefore the tightest for every outcome, and the
  // visible detail window is 104 chars for all five; the visible-prefix test
  // below checks variants 3, 4 and 5 with both summaries.
  const outcomes: Array<{ summary: string; detail: string; claims: string[] }> = [
    {
      summary: "restored database schema migration failed",
      detail:
        "The restore did not become active. Library unchanged and still in use. Retry from the backup; no restart. The backup file was not changed.",
      claims: ["restore did not become active", "unchanged and still in use", "Retry from the backup", "no restart"],
    },
    {
      summary: "restored database schema migration failed",
      detail:
        "Restart Soluna: restore did not become active; no previous library; library is empty. Retry from backup. Nothing you save now will be kept. The backup file was not changed.",
      claims: [
        "restore did not become active",
        "no previous library",
        "library is empty",
        "Restart Soluna",
        "Retry from backup",
      ],
    },
    {
      summary: "restored database reopen failed",
      detail:
        "Restart Soluna: restore did not become active; at the live location; not reconnected. Retry from backup. If it does not load, retry from the backup. The backup file was not changed.",
      claims: [
        "restore did not become active",
        "at the live location",
        "not reconnected",
        "Restart Soluna",
        "Retry from backup",
      ],
    },
    {
      summary: "restored database reopen failed",
      detail:
        "Restart Soluna: restore did not become active; previous database kept; not put back. Retry from backup. Soluna could not reconnect. If it does not load, retry from the backup.",
      claims: [
        "restore did not become active",
        "previous database kept",
        "not put back",
        "Restart Soluna",
        "Retry from backup",
      ],
    },
    {
      summary: "restored database schema migration failed",
      detail:
        "Restart Soluna: restore did not become active; the library in use is unconfirmed. Retry from backup. The backup file was not changed.",
      claims: [
        "restore did not become active",
        "the library in use is unconfirmed",
        "Restart Soluna",
        "Retry from backup",
      ],
    },
  ];

  it("errorMessage includes the detail for every recovery outcome", () => {
    for (const { summary, detail } of outcomes) {
      const error = { code: "database", message: summary, retryable: false, detail };
      expect(errorMessage(error)).toBe(`${summary} (${detail})`);
      const notice = `Backup could not be restored: ${errorMessage(error)}`;
      expect(notice).toContain(detail);
      expect(notice).toContain("restore did not become active");
      // The displayed detail must not include private file paths or secrets.
      expect(detail).not.toContain("/");
      expect(detail).not.toContain("\\");
      expect(detail).not.toContain(".sqlite3");
      expect(detail).not.toContain(".backup");
      expect(detail.toLowerCase()).not.toContain("cookie");
      expect(detail.toLowerCase()).not.toContain("token");
      expect(detail.toLowerCase()).not.toContain("secret");
    }
  });

  it("the visible notice prefix already says (a), (b) and (c) without hovering", () => {
    // The settings screen shows `Backup could not be restored:
    // ${errorMessage(error)}` and `noticeSummary` truncates the visible text
    // to 177 chars + "…" (full text on hover). The retry guidance used to sit
    // past that cut in all four outcomes, and in variant 1 the "no restart"
    // did too — so a user who never hovered learned the restore failed but
    // not what to do next. This test computes the notice string exactly as
    // the UI builds it and asserts every claim is already in the visible
    // prefix. The migration summary (41 chars) is the tightest summary for
    // every outcome — the migration branch's rollback can select any of the
    // five outcomes — so the visible detail window is 104 chars for all
    // five, and the migration pairing is the worst case. Variants 3, 4 and 5
    // are therefore checked twice: with their reopen summary (the pairing
    // the reopen branch produces) and with the migration summary (the
    // pairing the migration branch produces when the reopen fails on the
    // just-renamed previous database).
    const migrationSummary = "restored database schema migration failed";
    const reopenSummary = "restored database reopen failed";
    const [variant1, variant2, variant3, variant4, variant5] = outcomes;
    const pairs = [
      variant1,
      variant2,
      variant3,
      variant4,
      variant5,
      { ...variant3, summary: migrationSummary },
      { ...variant4, summary: migrationSummary },
      { ...variant5, summary: reopenSummary },
    ];
    for (const { summary, detail, claims } of pairs) {
      const error = { code: "database", message: summary, retryable: false, detail };
      const notice = `Backup could not be restored: ${errorMessage(error)}`;
      const visible = noticeSummary(notice);
      // The test only means something if the notice is actually truncated.
      expect(notice.length).toBeGreaterThan(180);
      expect(visible.endsWith("…")).toBe(true);
      for (const claim of claims) {
        expect(visible).toContain(claim);
      }
    }
  });
});
