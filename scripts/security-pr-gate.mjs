#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runGate } from './trusted-pr-gate.mjs'
import { reviewSubmission, MODEL } from './llm-review.mjs'

export const CHECK_NAME = 'Workbench security review'
const escape = (value) => String(value).replace(/[<>&`]/g, ' ').replace(/@/g, '＠')

export function buildReviewComment({ conclusion, report, summary, sha }) {
  if (conclusion === 'success') return null
  const shortSha = sha ? `\`${sha.slice(0, 7)}\`` : ''
  const lines = [
    `### ❌ 工作台安全与规范审查未通过 ${shortSha ? `(${shortSha})` : ''}`,
    '',
    '本次自动安全审查未能通过，请参考以下改进意见进行调整：',
    ''
  ]
  if (report?.summary) {
    lines.push(`> **审核综述**：${escape(report.summary)}`, '')
  }
  if (report?.criteria) {
    const blocking = report.criteria.filter((item) => item.status !== 'pass')
    if (blocking.length) {
      lines.push('#### 🚫 阻断项（需修改）：', '')
      for (const item of blocking) {
        lines.push(`- **\`${item.id}\`** (${item.status})：${escape(item.reason)}`)
      }
      lines.push('')
    }
  } else if (summary) {
    lines.push(`- **未通过原因**：${summary}`, '')
  }
  lines.push('---', '💡 修改完成后推送到当前 PR 分支即可，系统将自动重新执行安全门禁。')
  return lines.join('\n')
}

export async function runSecurityGate({ env = process.env, fetchImpl = fetch, gate = runGate, reviewer = reviewSubmission } = {}) {
  const { REPOSITORY: repository, CANDIDATE_SHA: sha, GITHUB_TOKEN: token, PR_NUMBER: number } = env
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(sha || '') || !/^[1-9]\d*$/.test(number || '') || !token) throw new Error('缺少可信运行上下文')
  const api = async (endpoint, method = 'GET', body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`GitHub 审核 API 返回 ${response.status}`)
    return response.json()
  }
  const current = await api(`/pulls/${number}`)
  if (current.state !== 'open' || current.head?.sha !== sha || current.base?.ref !== 'main' || current.base?.repo?.full_name !== repository) throw new Error('PR 已关闭、无法关联或 head 已更新，审核未完成')
  const check = await api('/check-runs', 'POST', { name: CHECK_NAME, head_sha: sha, status: 'in_progress' })
  let conclusion = 'failure', summary = '审核未完成', report, record
  try {
    const result = await gate({ env, fetchImpl, review: (context) => { record = context.record.entry; return reviewer({ ...context, env }) } })
    const fresh = await api(`/pulls/${number}`)
    if (fresh.state !== 'open' || fresh.head.sha !== sha || (fresh.body || '') !== (current.body || '')) throw new Error('PR 已更新，旧提交结论不能用于当前 head')
    if (result.type === 'submission') {
      report = result.review
      if (!report || typeof report.passed !== 'boolean') throw new Error('缺少 LLM 审核结果')
      conclusion = report.passed ? 'success' : 'failure'
      summary = [
        `模型：${MODEL}；PR head：${sha}；源码：${report.sourceCommit}`,
        `材料 SHA-256：${report.evidenceDigest}；标准 SHA-256：${report.standardsDigest}`,
        `分发：${escape(JSON.stringify(report.distribution))}`,
        escape(report.summary),
        escape(report.limitations || '本次为静态审核，未验证 Desktop 实机运行。'),
        ...report.criteria.map((item) => `- ${item.id}: **${item.status}** — ${escape(item.reason)}（${item.evidence.map((ref) => escape(ref.file) + (ref.startLine ? `:${ref.startLine}-${ref.endLine}` : '')).join(', ')}）`),
        '此结论仅覆盖上述快照；机器审核不证明 Desktop 实测或完整安全审计。全部目录 CI 通过且投稿未变化后，由独立发布步骤自动合并。'
      ].join('\n\n')
    } else {
      conclusion = 'success'
      summary = `${result.type === 'removal' ? '下架' : '仓库维护'} PR，无新增或修改工作台；不调用模型。仍需维护者批准。`
    }
  } catch (error) {
    // Never output API bodies, full source or raw model text.
    console.error('[security-pr-gate error]:', error.message)
    summary = `安全审核未完成或失败，禁止视为通过。${escape(error.message).slice(0, 1000)}`
  }
  await api(`/check-runs/${check.id}`, 'PATCH', { status: 'completed', conclusion,
    output: { title: conclusion === 'success' ? '安全门禁通过；等待目录 CI 与发布确认' : '安全门禁未通过', summary: summary.slice(0, 60000) } })
  if (conclusion !== 'success') {
    try {
      const commentBody = buildReviewComment({ conclusion, report, summary, sha })
      if (commentBody) {
        const comments = await api(`/issues/${number}/comments?per_page=30`).catch(() => [])
        const alreadyCommented = Array.isArray(comments) && comments.some((c) => c.body?.includes(sha.slice(0, 7)))
        if (!alreadyCommented) {
          await api(`/issues/${number}/comments`, 'POST', { body: commentBody })
        }
      }
    } catch (commentError) {
      console.error('[security-pr-gate comment error]:', commentError.message)
    }
  }
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  const publish = conclusion === 'success' && report?.passed === true
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, `publish=${publish}\n`)
  if (publish && env.SECURITY_BRIEF_FILE) await fs.writeFile(env.SECURITY_BRIEF_FILE, JSON.stringify({ repository, number, sha, body: current.body || '', record, evidenceDigest: report.evidenceDigest, model: MODEL }), { mode: 0o600 })
  return { failed: conclusion !== 'success', report, summary }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const res = await runSecurityGate()
    if (res.failed) {
      if (res.summary) console.error(res.summary)
      process.exitCode = 1
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
