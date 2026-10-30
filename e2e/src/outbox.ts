import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EMAIL_OUTBOX } from './env';

interface OutboxEmail { to: string; subject: string; html: string }

/** The newest email the backend wrote to its dev outbox for `to` (EMAIL_OUTBOX_DIR), or a failure with a hint. */
export function lastEmailTo(to: string): OutboxEmail {
  const dir = resolve(__dirname, '..', EMAIL_OUTBOX);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    throw new Error(`no email outbox at ${dir}: set EMAIL_OUTBOX_DIR in backend/.env (dev/test only)`);
  }
  for (const file of files.reverse()) {
    const mail = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as OutboxEmail;
    if (mail.to === to) return mail;
  }
  throw new Error(`no email to ${to} in ${dir}: is EMAIL_OUTBOX_DIR set in backend/.env?`);
}

/** The set-password token from the newest portal invite sent to `to`. */
export function inviteTokenFor(to: string): string {
  const match = lastEmailTo(to).html.match(/set-password\?token=([\w.-]+)/);
  if (!match) throw new Error(`the newest email to ${to} has no set-password link`);
  return match[1];
}
