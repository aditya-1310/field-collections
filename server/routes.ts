import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { compare } from 'bcryptjs';
import { z } from 'zod';
import type { User } from '../shared/types';
import { query, transaction } from './db';
import { checksum, HttpError, id } from './http';
import { todayIST } from './policy';
import {
  loanDetail,
  mapPromise,
  portfolio,
  publicUser,
  scopedOfficers,
} from './portfolio';
import { operationRoutes } from './operations';
import { importRoutes } from './imports';
import { reportingRoutes } from './reports';

const sessionCookie = 'fieldnote_session';
const sessionAge = 12 * 60 * 60 * 1000;
const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};
const loginBody = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((email) => email.toLowerCase()),
    password: z
      .string()
      .min(1)
      .max(72)
      .refine((password) => Buffer.byteLength(password) <= 72),
  })
  .strict();
const dummyHash =
  '$2b$10$gRuYPiKL7huyohCBRuL.1O/GICpdJHRUE.GA2p4v7IrB7HLwxwiem';

export function currentUser(res: Response): User {
  return res.locals.user as User;
}

export function managerOnly(
  _req: Request,
  res: Response,
  next: (err?: unknown) => void,
) {
  if (currentUser(res).role !== 'branch_manager')
    return next(
      new HttpError(403, 'A branch manager must perform this action.'),
    );
  next();
}

export function officerOnly(
  _req: Request,
  res: Response,
  next: (err?: unknown) => void,
) {
  if (currentUser(res).role !== 'field_officer')
    return next(
      new HttpError(403, 'A field officer must perform this action.'),
    );
  next();
}

export function apiRoutes(now: () => Date) {
  const routes = Router();
  routes.get('/health', async (_req, res) => {
    await query('SELECT 1');
    res.json({ ok: true });
  });
  routes.post(
    '/auth/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: 'Too many sign-in attempts. Try again in a few minutes.',
      },
    }),
    async (req, res) => {
      const credentials = loginBody.parse(req.body);
      const row = (
        await query('SELECT * FROM users WHERE email=$1 AND is_active', [
          credentials.email,
        ])
      ).rows[0];
      const valid = await compare(
        credentials.password,
        row ? String(row.password_hash) : dummyHash,
      );
      if (!row || !valid)
        throw new HttpError(401, 'The email or password is incorrect.');
      const token = randomBytes(32).toString('hex');
      const time = now();
      const oldToken = req.cookies[sessionCookie];
      await transaction(async (tx) => {
        await tx.query('DELETE FROM sessions WHERE expires_at <= $1', [
          time.toISOString(),
        ]);
        if (typeof oldToken === 'string' && /^[a-f0-9]{64}$/.test(oldToken)) {
          await tx.query('DELETE FROM sessions WHERE token_hash=$1', [
            checksum(oldToken),
          ]);
        }
        await tx.query(
          'INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)',
          [
            checksum(token),
            row.id,
            new Date(time.getTime() + sessionAge).toISOString(),
          ],
        );
      });
      res.cookie(sessionCookie, token, {
        ...cookieOptions,
        maxAge: sessionAge,
      });
      res.json({ user: publicUser(row) });
    },
  );

  routes.use(async (req, res, next) => {
    const token = req.cookies[sessionCookie];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new HttpError(401, 'Sign in to continue.');
    }
    const sessionHash = checksum(token);
    const row = (
      await query(
        'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.is_active',
        [sessionHash, now().toISOString()],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(401, 'Your session has ended. Sign in to continue.');
    res.locals.user = publicUser(row);
    res.locals.sessionHash = sessionHash;
    next();
  });
  routes.get('/auth/me', (_req, res) => res.json({ user: currentUser(res) }));
  routes.post('/auth/logout', async (_req, res) => {
    await query('DELETE FROM sessions WHERE token_hash=$1', [
      res.locals.sessionHash,
    ]);
    res.clearCookie(sessionCookie, cookieOptions);
    res.json({ ok: true });
  });

  routes.get('/loans', async (_req, res) => {
    const user = currentUser(res);
    const time = now();
    res.json({
      loans: await portfolio(user, time),
      user,
      serverTime: time.toISOString(),
    });
  });
  routes.get('/loans/:id', async (req, res) => {
    res.json(
      await loanDetail(currentUser(res), id.parse(req.params.id), now()),
    );
  });
  routes.get('/officers', managerOnly, async (_req, res) => {
    res.json({ officers: await scopedOfficers(currentUser(res)) });
  });
  routes.get('/branches', async (_req, res) => {
    res.json({
      branches: (
        await query('SELECT id,code,name FROM branches WHERE id=$1', [
          currentUser(res).branch_id,
        ])
      ).rows,
    });
  });
  routes.get('/promises', async (_req, res) => {
    const user = currentUser(res);
    const rows = (
      await query(
        "SELECT p.id,p.loan_id,p.promised_amount,p.due_date,p.status,p.version,l.external_loan_id,b.display_name AS borrower_name,u.full_name AS officer_name,COALESCE((SELECT SUM(m.amount) FROM mock_payments m WHERE m.promise_id=p.id AND (m.occurred_at AT TIME ZONE 'Asia/Kolkata')::date<=p.due_date),0) AS paid_by_due FROM promises p JOIN loans l ON l.id=p.loan_id JOIN borrowers b ON b.id=l.borrower_id LEFT JOIN users u ON u.id=l.assigned_officer_id WHERE l.branch_id=$1 AND ($2::uuid IS NULL OR l.assigned_officer_id=$2) AND p.status <> 'superseded' ORDER BY p.due_date,p.created_at DESC",
        [user.branch_id, user.role === 'field_officer' ? user.id : null],
      )
    ).rows;
    const day = todayIST(now());
    res.json({
      promises: rows.map((row) => ({ ...row, ...mapPromise(row, day) })),
    });
  });
  routes.use(importRoutes(now));
  routes.use(operationRoutes(now));
  routes.use(reportingRoutes(now));
  return routes;
}
