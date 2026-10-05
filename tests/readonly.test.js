"use strict";

// 验证两栏只读开关（PRAGMA query_only）的前端行为：
//  - 默认关闭、状态渲染勾选框与徽标
//  - 切换期间本栏全部控件禁用，另一栏不受影响
//  - 失败 / 410 / 404 / 迟到响应沿用旧的隔离规则
//  - 新建成功后开关复位为关闭
// 运行：node tests/readonly.test.js

const {
  loadApp,
  flush,
  statusBody,
  bootOldLive,
  settleNewCreated,
} = require("./harness");

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
  }
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name);
    console.error("      " + e.message);
  }
}

// 触发勾选：直接置 checked 再派发 change
function toggle(ctx, side, checked) {
  const el = ctx.el(`ro-toggle-${side}`);
  el.checked = checked;
  el.dispatchChange();
}

async function main() {
  // 1. 默认关闭；status 中 readonly=true 时勾选框勾选、徽标显示
  await test("默认关闭；状态渲染只读勾选框与徽标", async () => {
    const ctx = loadApp("?exp=OLD");
    await flush();
    ctx.settle("/OLD/status", 200, statusBody("OLD", { aReadonly: true }));
    await flush();
    ctx.settle("/OLD/committed", 200, { committed: 100 });
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, true, "甲勾选框应勾选");
    assertEq(ctx.el("ro-badge-a").hidden, false, "甲只读徽标应显示");
    assertEq(ctx.el("ro-toggle-b").checked, false, "乙勾选框保持关闭（两栏独立）");
    assertEq(ctx.el("ro-badge-b").hidden, true, "乙徽标隐藏");

    // 手动触发一轮轮询，状态带 readonly 回来：取消 / 勾选勾选框
    ctx.tickTimers(1);
    await flush();
    ctx.settle(
      "/OLD/status",
      200,
      statusBody("OLD", { aReadonly: false, bReadonly: true })
    );
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, false, "甲勾选框随状态取消");
    assertEq(ctx.el("ro-badge-a").hidden, true, "甲徽标隐藏");
    assertEq(ctx.el("ro-toggle-b").checked, true, "乙勾选框随状态勾选");
    assertEq(ctx.el("ro-badge-b").hidden, false, "乙徽标显示");
  });

  // 2. 切换请求在途：本栏全部控件禁用（含勾选框与加法按钮），另一栏可用
  await test("切换在途禁用本栏全部控件，另一栏不受影响", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);

    toggle(ctx, "a", true);
    await flush();
    const req = ctx.findCall("/conn/a/readonly", "POST");
    assert(req, "应发出甲只读切换请求");
    assertEq(ctx.el("ro-toggle-a").disabled, true, "甲勾选框在途禁用");
    assertEq(ctx.opButton("a", "add").disabled, true, "甲加法按钮在途禁用");
    assertEq(ctx.opButton("a", "begin").disabled, true, "甲 BEGIN 在途禁用");
    assertEq(ctx.el("ro-toggle-b").disabled, false, "乙勾选框不受影响");
    assertEq(ctx.opButton("b", "add").disabled, false, "乙加法按钮不受影响");

    // 在途期间轮询状态回来，不得把甲勾选框弹回关闭（sideBusy 保护）
    ctx.tickTimers(1);
    await flush();
    ctx.settle(
      "/OLD/status",
      200,
      statusBody("OLD", { aReadonly: false })
    );
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, true, "在途期间轮询不得回写甲勾选框");

    // 成功响应以服务端状态为准
    req.settled = true;
    req.resolve({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        error: null,
        readonly: true,
        state: statusBody("OLD", { aTx: true, aReadonly: true }).a,
      }),
    });
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, true, "成功后保持勾选");
    assertEq(ctx.el("ro-badge-a").hidden, false, "成功后徽标显示");
    assertEq(ctx.el("ro-toggle-a").disabled, false, "成功后恢复可用");
  });

  // 3. 切换失败（HTTP 500）：勾选框回退到最近已知值，控件恢复，错误显示
  await test("切换失败：勾选框回退、本栏恢复、显示错误", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);

    toggle(ctx, "b", true);
    await flush();
    ctx.settle("/conn/b/readonly", 500, {});
    await flush();
    assertEq(ctx.el("ro-toggle-b").checked, false, "失败后勾选框回退为关闭");
    assertEq(ctx.el("ro-toggle-b").disabled, false, "失败后控件恢复");
    assertEq(ctx.el("error-b").hidden, false, "失败显示在乙栏错误框");
  });

  // 4. 切换收到 410：冻结旧实验，勾选框随冻结禁用
  await test("切换 410：冻结旧实验且不自动新建", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    toggle(ctx, "a", true);
    await flush();
    ctx.settle("/conn/a/readonly", 410, {});
    await flush();
    assertEq(ctx.app().expFrozen, true, "410 冻结");
    assertEq(
      ctx.calls.filter((c) => c.method === "POST" && c.path === "/api/experiments")
        .length,
      0,
      "410 不自动新建"
    );
    assertEq(ctx.el("deleted-note").hidden, false, "显示冻结提示");
  });

  // 5. 切换收到 404：沿用旧语义自动新建
  await test("切换 404：自动新建实验", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    toggle(ctx, "a", true);
    await flush();
    ctx.settle("/conn/a/readonly", 404, {});
    await flush();
    const post = ctx.calls.find(
      (c) => c.method === "POST" && c.path === "/api/experiments" && !c.settled
    );
    assert(post, "404 后应自动发起新建");
    await settleNewCreated(ctx);
    assertEq(ctx.app().expId, "NEW", "自动新建后切到 NEW");
  });

  // 6. 旧只读切换的迟到成功响应在新建成功后收尾：不冻结、不改勾选框 / 徽标
  await test("旧只读切换迟到成功：不冻结、不覆盖新实验开关", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    toggle(ctx, "a", true);
    await flush();
    const stale = ctx.findCall("/conn/a/readonly", "POST");
    assert(stale, "切换请求在途");

    ctx.el("new-exp").click();
    await flush();
    await settleNewCreated(ctx);
    assertEq(ctx.app().expId, "NEW", "已切到 NEW");
    assertEq(ctx.el("ro-toggle-a").checked, false, "新实验开关复位关闭");

    // 旧请求成功收尾（带 readonly=true 的旧状态）
    stale.settled = true;
    stale.resolve({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        error: null,
        readonly: true,
        state: statusBody("OLD", { aReadonly: true }).a,
      }),
    });
    await flush();
    assertEq(ctx.app().expId, "NEW", "迟到成功不切回 OLD");
    assertEq(ctx.app().expFrozen, false, "迟到成功不冻结");
    assertEq(ctx.el("ro-toggle-a").checked, false, "迟到成功不得勾选新实验开关");
    assertEq(ctx.el("ro-badge-a").hidden, true, "迟到成功不得显示新实验徽标");
    assertEq(ctx.app().timerCount, 2, "新实验轮询仍在运行");
  });

  // 7. 新建成功后两栏开关均复位关闭，即使旧实验曾开启
  await test("新建成功复位两栏只读开关", async () => {
    const ctx = loadApp("?exp=OLD");
    await flush();
    ctx.settle("/OLD/status", 200, statusBody("OLD", { aReadonly: true, bReadonly: true }));
    await flush();
    ctx.settle("/OLD/committed", 200, { committed: 100 });
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, true, "前置：甲开关开启");
    assertEq(ctx.el("ro-toggle-b").checked, true, "前置：乙开关开启");

    ctx.el("new-exp").click();
    await flush();
    await settleNewCreated(ctx);
    assertEq(ctx.el("ro-toggle-a").checked, false, "甲开关复位");
    assertEq(ctx.el("ro-toggle-b").checked, false, "乙开关复位");
    assertEq(ctx.el("ro-badge-a").hidden, true, "甲徽标复位隐藏");
    assertEq(ctx.el("ro-badge-b").hidden, true, "乙徽标复位隐藏");
  });

  // 8. 请求体携带真正的布尔值
  await test("切换请求体为 JSON 布尔字段 readonly", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    toggle(ctx, "a", true);
    await flush();
    const req = ctx.findCall("/conn/a/readonly", "POST");
    assertEq(req.method, "POST", "POST 方法");
    assert(req.path.includes("/api/experiments/OLD/conn/a/readonly"), "路径含实验与栏位");
    assertEq(req.body, JSON.stringify({ readonly: true }), "请求体 {readonly:true}");
  });

  console.log(`\n${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
