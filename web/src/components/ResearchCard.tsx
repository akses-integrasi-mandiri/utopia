/* 联网调研卡（人审批制）：回答写完后评估知识覆盖，不够才挂这张卡。
   「联网调研」永远要人亲手点——没有自动外网调研；点过才建任务（approved: true），
   进度轮询任务本身，COMPLETED 后自动用原问题重问一次（只一次，且发送被接受
   才算数），PARTIAL/FAILED 摆出错来、给人重试的按钮，不装成成功。 */
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { researchApi, type ResearchJob, type ResearchJobState } from "../api";
import { S } from "../i18n";
import { toast } from "../toast";
import { Button, Status } from "../ui";
import type { Turn } from "../liveAnswer";

/* ---------- 判据（纯函数，单测直接打这些） ---------- */

const TERMINAL: ReadonlySet<ResearchJobState> = new Set(["COMPLETED", "FAILED", "PARTIAL"]);

/** 终态：轮询到这里就停 */
export const researchTerminal = (s: ResearchJobState) => TERMINAL.has(s);

/** 同一道题的已有任务：恢复页面/防重复调研都按它认领 */
export const pickResearchJob = (
  jobs: ResearchJob[] | undefined,
  query: string,
): ResearchJob | undefined => jobs?.find((j) => j.query === query);

const GREETING_EN =
  /^(hi|hello|hey|yo|hiya|howdy|good\s+(morning|afternoon|evening)|thanks|thank\s+you|ok(ay)?|yes|no|bye|goodbye)[.!?,。！？\s]*$/i;
const GREETING_ZH = /^(你好|您好|嗨|喂|谢谢|谢了|多谢|嗯+|好|好的|行|再见|拜拜)[！。？~…\s]*$/;

/** 招呼不评估调研：「你好」 Coverage 评估没有意义，卡片只会吵 */
export const isGreetingQuery = (q: string) => {
  const t = q.trim();
  return GREETING_EN.test(t) || GREETING_ZH.test(t);
};

/** 回答/步骤里带着「这道题不需要证据」的标记（工具 no_evidence_needed）：不挂卡 */
export const hasNoEvidenceNeeded = (turn: Turn) =>
  /no_evidence_needed/.test(turn.content) ||
  (turn.steps ?? []).some(
    (s) => /no_evidence_needed/.test(s.label) || /no_evidence_needed/.test(s.detail),
  );

/** 这轮对话此刻该不该评估调研：得有一句真说完的人话，且不是招呼/免证据的工具轮。
 *  还在等回答（最后是 user）、报错的、空的不算。返回那句人话，否则 null。 */
export function researchQueryFor(turns: Turn[]): string | null {
  if (turns.length < 2) return null;
  const last = turns[turns.length - 1];
  if (last.role !== "assistant" || !last.content || last.error) return null;
  const prev = turns[turns.length - 2];
  if (prev.role !== "user") return null;
  const q = prev.content.trim();
  if (!q || isGreetingQuery(q) || hasNoEvidenceNeeded(last)) return null;
  return q;
}

/* 「已自动重问」标记：kb + job 作键。发送被挡住不写标记（见组件里调用顺序），
   下次还有机会；存不下（隐私模式）只丢一次去重，不挂。 */
const rerunKey = (kbId: string, jobId: string) => `aim:research:rerun:${kbId}:${jobId}`;

export const hasRerunMarker = (kbId: string, jobId: string): boolean => {
  try {
    return globalThis.localStorage?.getItem(rerunKey(kbId, jobId)) === "1";
  } catch {
    return false;
  }
};

export const markRerun = (kbId: string, jobId: string) => {
  try {
    globalThis.localStorage?.setItem(rerunKey(kbId, jobId), "1");
  } catch {
    /* 存不下就只丢一次去重 */
  }
};

/** 现在该不该自动重问原问题。COMPLETED、没重问过、没在流式，三个都占才动；
 *  任何一条不满足都**不写标记**——这次没问出去就不算问过 */
export function shouldAutoRequery(job: ResearchJob, kbId: string, streaming: boolean): boolean {
  return (
    job.state === "COMPLETED" &&
    !streaming &&
    !hasRerunMarker(kbId, job.id)
  );
}

/* ---------- 卡片 ---------- */

export function ResearchCard({
  kbId,
  conversationId,
  query,
  canWrite,
  streaming,
  onRequery,
}: {
  kbId: string;
  conversationId: string | null;
  /** 当前该评估的那句人话（researchQueryFor 的产出）；null = 不挂卡 */
  query: string | null;
  /** 后端按 editor 权限收口写操作；viewer 只看得见、按不动 */
  canWrite: boolean;
  streaming: boolean;
  /** 用原问题走正常的发送管线重问一次。返回 false = 发送被挡住，不记「已重问」 */
  onRequery: (q: string) => boolean;
}) {
  const queryClient = useQueryClient();
  const onRequeryRef = useRef(onRequery);
  onRequeryRef.current = onRequery;

  // 覆盖评估。键里带 kb + 会话 + 那句话：换库/换会话/换问题各自独立缓存
  const coverage = useQuery({
    queryKey: ["research", "coverage", kbId, conversationId, query],
    queryFn: () =>
      researchApi.coverage(kbId, {
        query: query!,
        conversation_id: conversationId ?? undefined,
      }),
    enabled: !!query && !streaming,
    staleTime: Infinity,
    retry: false,
  });

  // 这个会话已有的任务：恢复页面时认领导航，避免同一道题重复调研
  const jobs = useQuery({
    queryKey: ["research", "jobs", kbId, conversationId],
    queryFn: () => researchApi.list(kbId, conversationId!),
    enabled: !!conversationId,
  });

  // 这道题的任务：非终态每 2s 轮询一次，到终态即停
  const job = pickResearchJob(jobs.data, query ?? "");
  const progress = useQuery({
    queryKey: ["research", "job", kbId, job?.id],
    queryFn: () => researchApi.get(kbId, job!.id),
    enabled: !!job && !researchTerminal(job.state),
    refetchInterval: (q) => {
      const data = q.state.data as ResearchJob | undefined;
      return data && researchTerminal(data.state) ? false : 2000;
    },
  });
  const liveJob: ResearchJob | undefined = job ? (progress.data ?? job) : undefined;

  /** COMPLETED → 自动重问原问题，只一次。effect 不带依赖数组：标记与流式状态
   *  一变判据自己重算；onRequery 返回 false（被挡住）时不写标记，下轮渲染再来 */
  useEffect(() => {
    if (!liveJob || liveJob.state !== "COMPLETED") return;
    // 任务认错了会话不动手：切走/卸载之后绝不往别的会话里发消息
    if (liveJob.conversation_id && liveJob.conversation_id !== conversationId) return;
    if (!shouldAutoRequery(liveJob, kbId, streaming)) return;
    if (onRequeryRef.current(liveJob.query)) markRerun(kbId, liveJob.id);
  });

  // 人点「联网调研」：approved 恒为 true；request_id 每次点击/重试重新生成，
  // 幂等键跟着这一次意图走
  const create = useMutation({
    mutationFn: () =>
      researchApi.create(kbId, {
        query: query!,
        conversation_id: conversationId ?? undefined,
        approved: true,
        request_id: crypto.randomUUID(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["research", "jobs", kbId, conversationId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!query) return null;

  /* 已有任务：只报任务，不再评估覆盖（任务存在本身就是这道题的裁决） */
  if (liveJob) {
    if (!researchTerminal(liveJob.state)) {
      return (
        <div className="mt-2 glass rounded-panel px-3 py-2 space-y-1">
          <Status pulse tone="info">
            {S.ask.researchStates[liveJob.state]}
          </Status>
          <div className="text-fine text-ink-2">
            {S.ask.researchCounts(liveJob.sources_discovered, liveJob.ingested_documents)}
          </div>
        </div>
      );
    }
    if (liveJob.state === "COMPLETED") {
      return (
        <div className="mt-2 glass rounded-panel px-3 py-2">
          <Status tone="success">{S.ask.researchStates.COMPLETED}</Status>
          <div className="mt-1 text-fine text-ink-2">
            {S.ask.researchCounts(liveJob.sources_discovered, liveJob.ingested_documents)}
          </div>
        </div>
      );
    }
    /* FAILED / PARTIAL：有用的错 + 显式重试，不装成成功 */
    return (
      <div className="mt-2 glass rounded-panel px-3 py-2 space-y-2">
        <Status tone="warn">
          {liveJob.state === "FAILED" ? S.ask.researchFailed : S.ask.researchPartial}
        </Status>
        {liveJob.error && <div className="text-small text-danger">{liveJob.error}</div>}
        <Button
          size="sm"
          icon={<Globe size={12} />}
          busy={create.isPending}
          disabled={!canWrite || streaming}
          onClick={() => create.mutate()}
        >
          {S.ask.researchRetry}
        </Button>
      </div>
    );
  }

  /* 没有任务：看覆盖评估的结果 */
  if (coverage.isError) {
    return (
      <div className="mt-2 text-small text-danger">
        {S.ask.researchError}
        {coverage.error instanceof Error && coverage.error.message
          ? `: ${coverage.error.message}`
          : ""}
      </div>
    );
  }
  if (!coverage.data) return null; // 还在评：先不占地方，评估完才长出来
  if (!coverage.data.available) {
    // 没配置联网调研：说清楚，不给按钮——这条路今天就是不通
    return (
      <div className="mt-2 glass rounded-panel px-3 py-2">
        <Status tone="neutral">{S.ask.researchUnavailable}</Status>
      </div>
    );
  }
  if (coverage.data.sufficient) return null; // 够用：不挂卡，评估结果留在缓存里

  return (
    <div className="mt-2 glass rounded-panel px-3 py-2 space-y-2">
      <div className="text-small text-ink">{S.ask.researchTitle}</div>
      {coverage.data.reason && (
        <div className="text-fine text-ink-2">{coverage.data.reason}</div>
      )}
      <Button
        size="sm"
        icon={<Globe size={12} />}
        busy={create.isPending}
        disabled={!canWrite || streaming}
        onClick={() => create.mutate()}
      >
        {S.ask.researchInternet}
      </Button>
    </div>
  );
}
