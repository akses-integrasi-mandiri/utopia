import { beforeEach, describe, expect, it } from "vitest";
import type { ResearchJob, ResearchJobState } from "../api";
import type { Turn } from "../liveAnswer";
import {
  hasNoEvidenceNeeded,
  hasRerunMarker,
  isGreetingQuery,
  markRerun,
  pickResearchJob,
  researchQueryFor,
  researchTerminal,
  shouldAutoRequery,
} from "./ResearchCard";

const user = (content: string): Turn => ({ role: "user", content });
const assistant = (over: Partial<Turn> = {}): Turn => ({
  role: "assistant",
  content: "以下是我找到的内容",
  ...over,
});

const job = (over: Partial<ResearchJob> = {}): ResearchJob => ({
  id: "job-1",
  kb_id: "kb-1",
  conversation_id: "conv-1",
  query: "Acme 去年的营收是多少？",
  state: "QUEUED",
  error: null,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
  sources_discovered: 0,
  sources_accepted: 0,
  sources_rejected: 0,
  duplicates: 0,
  ingested_documents: 0,
  document_ids: [],
  ...over,
});

describe("researchQueryFor", () => {
  it("picks the last user question once a real answer finished", () => {
    const turns = [user("你好"), assistant(), user("Acme 去年的营收是多少？"), assistant()];
    expect(researchQueryFor(turns)).toBe("Acme 去年的营收是多少？");
  });

  it("returns null while the answer is still pending (last turn is the user question)", () => {
    expect(researchQueryFor([user("Acme 去年的营收是多少？")])).toBeNull();
  });

  it("returns null for an error or empty assistant turn", () => {
    expect(
      researchQueryFor([user("Acme 去年的营收是多少？"), assistant({ error: "model unreachable" })]),
    ).toBeNull();
    expect(
      researchQueryFor([user("Acme 去年的营收是多少？"), assistant({ content: "" })]),
    ).toBeNull();
  });

  it("skips greeting rounds — no card for hi/hello/你好", () => {
    for (const g of ["hi", "Hello!", "hey", "good morning", "谢谢", "你好", "您好！"]) {
      expect(isGreetingQuery(g)).toBe(true);
      expect(researchQueryFor([user(g), assistant()])).toBeNull();
    }
  });

  it("still evaluates real questions that merely start politely", () => {
    expect(isGreetingQuery("你好，Acme 去年的营收是多少？")).toBe(false);
    expect(researchQueryFor([user("你好，Acme 去年的营收是多少？"), assistant()])).toBe(
      "你好，Acme 去年的营收是多少？",
    );
  });

  it("skips turns the tool stack marked as needing no evidence", () => {
    expect(
      hasNoEvidenceNeeded(assistant({ content: "…no_evidence_needed…" })),
    ).toBe(true);
    expect(
      researchQueryFor([
        user("今天几号？"),
        assistant({
          content: "今天是 9 月 29 日。",
          steps: [{ kind: "tool", label: "no_evidence_needed", detail: "clock" }],
        }),
      ]),
    ).toBeNull();
  });
});

describe("pickResearchJob / researchTerminal", () => {
  it("finds the job for the exact same question", () => {
    const j = job();
    expect(pickResearchJob([job({ id: "other", query: "别的问题" }), j], j.query)).toBe(j);
  });

  it("returns undefined when no job matches the question", () => {
    expect(pickResearchJob([job()], "完全不同的问题")).toBeUndefined();
    expect(pickResearchJob(undefined, "whatever")).toBeUndefined();
  });

  it("treats COMPLETED/FAILED/PARTIAL as terminal, the pipeline states as live", () => {
    for (const s of ["COMPLETED", "FAILED", "PARTIAL"] as ResearchJobState[])
      expect(researchTerminal(s)).toBe(true);
    for (const s of ["QUEUED", "PLANNING", "SEARCHING", "CRAWLING", "EXTRACTING", "VALIDATING", "ENTITY_RESOLUTION", "READY_FOR_INGESTION", "INGESTING", "REQUERYING"] as ResearchJobState[])
      expect(researchTerminal(s)).toBe(false);
  });
});

describe("shouldAutoRequery", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  it("fires exactly once per job: only COMPLETED, not streaming, no marker yet", () => {
    const j = job({ state: "COMPLETED" });
    expect(shouldAutoRequery(j, "kb-1", false)).toBe(true);
    // 标记落上之后不再触发——刷新/重挂也不会重复重问
    markRerun("kb-1", j.id);
    expect(shouldAutoRequery(j, "kb-1", false)).toBe(false);
  });

  it("never fires while streaming, and PARTIAL/FAILED never auto-requery", () => {
    expect(shouldAutoRequery(job({ state: "COMPLETED" }), "kb-1", true)).toBe(false);
    expect(shouldAutoRequery(job({ state: "PARTIAL" }), "kb-1", false)).toBe(false);
    expect(shouldAutoRequery(job({ state: "FAILED" }), "kb-1", false)).toBe(false);
  });

  it("does not treat a missing marker as present when storage is unavailable", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(hasRerunMarker("kb-1", "job-1")).toBe(false);
    expect(shouldAutoRequery(job({ state: "COMPLETED" }), "kb-1", false)).toBe(true);
    // 存不下也不抛
    expect(() => markRerun("kb-1", "job-1")).not.toThrow();
  });

  it("keys the once-marker by kb and job", () => {
    markRerun("kb-1", "job-1");
    expect(hasRerunMarker("kb-1", "job-1")).toBe(true);
    expect(hasRerunMarker("kb-2", "job-1")).toBe(false);
    expect(hasRerunMarker("kb-1", "job-2")).toBe(false);
  });
});
