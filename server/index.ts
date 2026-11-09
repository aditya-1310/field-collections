import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { migrate, seed } from './db';
import { HttpError } from './http';
import { apiRoutes } from './routes';

export function createApp(options: { now?: () => Date } = {}) {
  const app = express();
  const now = options.now ?? (() => new Date());
  const production = process.env.NODE_ENV === 'production';
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          imgSrc: ["'self'", 'data:'],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
    }),
  );
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const sameOrigin: RequestHandler = (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const site = req.get('sec-fetch-site');
    const origin = req.get('origin');
    if (site === 'cross-site' || site === 'same-site') {
      return next(
        new HttpError(403, 'Send this request from the Fieldnote app.'),
      );
    }
    if (origin && origin !== req.protocol + '://' + req.get('host')) {
      return next(
        new HttpError(403, 'Send this request from the Fieldnote app.'),
      );
    }
    if (
      (Number(req.get('content-length') ?? 0) > 0 ||
        req.get('transfer-encoding')) &&
      !req.is('application/json')
    ) {
      return next(new HttpError(415, 'Send the request as JSON.'));
    }
    next();
  };
  app.use('/api', sameOrigin, express.json({ limit: '1mb' }), apiRoutes(now));
  app.use('/api', (_req, _res, next) =>
    next(new HttpError(404, 'This API route does not exist.')),
  );

  const dist = resolve('dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false }));
    app.get('/{*rest}', (_req, res) =>
      res.sendFile(resolve(dist, 'index.html')),
    );
  }

  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError)
      return res.status(error.status).json({ error: error.message });
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const field = issue?.path.join('.');
      return res
        .status(400)
        .json({
          error: field
            ? field + ': ' + issue.message
            : 'Check the submitted fields.',
        });
    }
    if (error?.type === 'entity.too.large')
      return res
        .status(413)
        .json({ error: 'The request exceeds the 1 MB limit.' });
    if (error?.type === 'entity.parse.failed')
      return res
        .status(400)
        .json({ error: 'The request contains invalid JSON.' });
    console.error('Unhandled API error', {
      code: error?.code,
      name: error?.name,
    });
    res
      .status(500)
      .json({ error: 'The request could not be completed. Please try again.' });
  };
  app.use(handleError);
  return app;
}

async function start() {
  await migrate();
  if (process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO === 'true')
    await seed();
  const port = Number(process.env.PORT || 3001);
  createApp().listen(port, '0.0.0.0', () =>
    console.log('Fieldnote listening on port ' + port),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  start().catch((error: unknown) => {
    console.error('Unable to start Fieldnote', {
      code: (error as { code?: string })?.code,
      name: (error as Error)?.name,
    });
    process.exitCode = 1;
  });
}
