// HRMP — Webhook بوت تيليغرام
// ---------------------------------------------------------------------------
// 1) ربط محادثة الباحث: /start <token> من أي محادثة (توكن أحادي 15 دقيقة).
// 2) أوامر المشرف فقط (/pending, /status, /help) من TELEGRAM_ADMIN_CHAT_ID.
// يُضبط عبر setWebhook مع secret_token؛ لا يُقبل طلب بلا السر الصحيح.
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

declare const process: { env: Record<string, string | undefined> };
const env = process.env;
import { db } from "@/lib/db";
import { sendTelegramTo } from "@/lib/telegram";
import { telegramLinkHash } from "@/lib/recruitment/telegram-link";
import { APP_VERSION } from "@/lib/version";

export const runtime = "nodejs";

function sameSecret(received: string | null): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function pendingSeekersCount(): Promise<number> {
  return db.jobSeeker.count({
    where: {
      status: "pending",
      emailVerifiedAt: { not: null },
      documentType: { not: null },
      // العامل الثاني: هاتف موثّق أو تيليغرام موثّق
      OR: [{ phoneVerifiedAt: { not: null } }, { telegramVerifiedAt: { not: null } }],
    },
  });
}

/**
 * ربط محادثة Telegram بحساب باحث عبر التوكن الأحادي.
 * كل الردود تذهب إلى نفس المحادثة؛ لا نكشف بيانات باحث آخر.
 */
async function linkSeekerChat(chatId: string, username: string | null, token: string): Promise<void> {
  const hash = telegramLinkHash(token);
  const seeker = await db.jobSeeker.findFirst({
    where: {
      telegramLinkTokenHash: hash,
      telegramLinkTokenExpiresAt: { gt: new Date() },
    },
    select: { id: true, fullName: true, telegramChatId: true },
  });
  if (!seeker) {
    await sendTelegramTo(
      chatId,
      "❌ رابط الربط غير صالح أو منتهٍ (15 دقيقة).\nارجع إلى صفحة تسجيل الباحث في HRMP وأعد المحاولة."
    );
    return;
  }
  if (seeker.telegramChatId && seeker.telegramChatId !== chatId) {
    await sendTelegramTo(chatId, "⚠️ هذا الحساب مرتبط بمحادثة تيليغرام أخرى. تواصل مع إدارة HRMP.");
    return;
  }

  const other = await db.jobSeeker.findFirst({
    where: { telegramChatId: chatId, NOT: { id: seeker.id } },
    select: { id: true },
  });
  if (other) {
    await sendTelegramTo(chatId, "⚠️ محادثة تيليغرام هذه مرتبطة بحساب باحث آخر.");
    return;
  }

  try {
    // شرط ذري: التوكن ما زال صالحًا والمحادثة غير مرتبطة بباحث آخر
    const updated = await db.jobSeeker.updateMany({
      where: {
        id: seeker.id,
        telegramLinkTokenHash: hash,
        telegramLinkTokenExpiresAt: { gt: new Date() },
        OR: [{ telegramChatId: null }, { telegramChatId: chatId }],
      },
      data: {
        telegramChatId: chatId,
        telegramUsername: username,
        telegramLinkedAt: new Date(),
        telegramLinkTokenHash: null,
        telegramLinkTokenExpiresAt: null,
      },
    });
    if (updated.count !== 1) {
      await sendTelegramTo(chatId, "⚠️ تعذّر الربط (استُهلك الرابط أو رُبط الحساب للتو). أعد المحاولة من الموقع.");
      return;
    }
    await sendTelegramTo(
      chatId,
      [
        "✅ تم ربط تيليغرام بحساب HRMP",
        `الاسم: ${seeker.fullName}`,
        "ارجع إلى صفحة التسجيل واضغط «إرسال الرمز عبر تيليغرام».",
        "لا تشارك هذا الرمز مع أي شخص.",
      ].join("\n")
    );
  } catch (error) {
    console.error("[telegram/webhook] link failed", error);
    await sendTelegramTo(chatId, "⚠️ تعذّر ربط المحادثة. حاول مجددًا لاحقًا.");
  }
}

export async function POST(req: NextRequest) {
  if (!sameSecret(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const update = await req.json().catch(() => null);
  const message = update?.message;
  const chatId = message?.chat?.id ? String(message.chat.id) : null;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const parts = text.split(/\s+/).filter(Boolean);
  const command = (parts[0] ?? "").toLowerCase();
  const payload = parts[1] ?? "";
  const adminId = env.TELEGRAM_ADMIN_CHAT_ID;
  const username =
    typeof message?.chat?.username === "string"
      ? message.chat.username
      : typeof message?.from?.username === "string"
        ? message.from.username
        : null;

  // ربط الباحث: يُقبل من أي محادثة (المحادثة نفسها هي التي ستستقبل OTP)
  if (chatId && command === "/start" && payload) {
    await linkSeekerChat(chatId, username, payload);
    return NextResponse.json({ ok: true });
  }

  // أي محادثة غير محادثة المشرف: رد تعريفي على /start فقط، وتجاهل الباقي
  // (لا رد على الأوامر يكشف وجود البوت أو صلاحياته)
  if (!chatId || !adminId || chatId !== adminId) {
    if (chatId && command === "/start") {
      await sendTelegramTo(
        chatId,
        "مرحبًا! لإضافة قناة OTP عبر تيليغرام، افتح رابط الربط من صفحة تسجيل الباحث في HRMP ثم اضغط Start."
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (command === "/start") {
    await sendTelegramTo(
      chatId,
      [
        "✅ HRMP Bot — متصل",
        `chat_id: ${chatId}`,
        "الأوامر: /pending · /status · /help",
        "ستصلك إشعارات الباحثين الجاهزين للمصادقة تلقائيًا.",
      ].join("\n")
    );
  } else if (command === "/pending") {
    const count = await pendingSeekersCount();
    await sendTelegramTo(
      chatId,
      `📋 بانتظار المصادقة: ${count}\nhttps://hrmp.pages.dev/dashboard/seekers`
    );
  } else if (command === "/status") {
    const count = await pendingSeekersCount();
    await sendTelegramTo(
      chatId,
      `HRMP v${APP_VERSION}\nالحالة: يعمل ✅\nبانتظار المصادقة: ${count}\nالوقت: ${new Date().toISOString()}`
    );
  } else {
    await sendTelegramTo(chatId, "الأوامر المتاحة: /pending · /status · /help");
  }

  // نرد 200 دائمًا كي لا يعيد تيليغرام المحاولة
  return NextResponse.json({ ok: true });
}
