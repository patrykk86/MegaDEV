#!/usr/bin/env node
/**
 * tools/gateway/run-gateway.mjs - Dedicated Standalone CLI Launcher for MegaDEV Telegram Gateway
 *
 * Runs the long-polling loop unconditionally with outbound secret scrubbing.
 */

import { runCli, scrubTelegramSecrets } from './telegram-bot.mjs';

runCli().catch((err) => {
  console.error('[Telegram Gateway] Fatal startup error:', scrubTelegramSecrets(err.message));
  process.exit(1);
});

