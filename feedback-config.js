/* 留言板配置 · 唯一需要手改的文件
 * ------------------------------------------------------------------
 * 部署好 Cloudflare Worker 后，把它的公开地址填进 endpoint 即可，例如：
 *   endpoint: 'https://lbjp-feedback.your-subdomain.workers.dev'
 *
 * 本地开发不用填：hostname 为 localhost / 127.0.0.1 时，游客端会自动
 * 改投 server/server.js 的 /api/feedback（模拟写入代理，方便离线冒烟）。
 *
 * ⚠️ 这里绝不能填 GitHub 令牌。游客页里的一切都是公开的。
 */
window.LBJP_FEEDBACK_CONFIG = {
  endpoint: '',                                  // ← Worker 地址（部署后填写）
  repo: 'youyituomaoxian/LBJP',
  branch: 'gh-pages',
  dataPath: 'data/messages.json',
  maxLen: 500,
  minLen: 4,
  cooldownMs: 30000
};
