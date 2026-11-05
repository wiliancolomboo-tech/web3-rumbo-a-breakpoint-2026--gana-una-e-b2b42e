import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import { NotificationService } from './services/notificationService';

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || 'RumbobReakpo1nt20261111111111111111111111'
);
const RPC_WEBSOCKET_URL = process.env.SOLANA_RPC_WS_URL || 'wss://api.devnet.solana.com';
const RPC_HTTP_URL = process.env.SOLANA_RPC_HTTP_URL || 'https://api.devnet.solana.com';

async function main() {
  console.log('====================================================');
  console.log('  Rumbo a Breakpoint 2026 - Event Orchestrator Daemon');
  console.log('====================================================');
  console.log(`Target Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`Connecting to WebSocket RPC: ${RPC_WEBSOCKET_URL}`);

  const connection = new Connection(RPC_HTTP_URL, {
    wsEndpoint: RPC_WEBSOCKET_URL,
    commitment: 'confirmed',
  });

  const notificationService = new NotificationService();

  // Test Discord Connectivity on startup
  await notificationService.broadcastDiscordAlert(
    'Watcher Initialized',
    'Rumbo a Breakpoint 2026 Orchestration Agent is online and monitoring real-time transactions.'
  );

  console.log('Listening to Solana on-chain program logs...');

  connection.onLogs(
    PROGRAM_ID,
    async (logsContext) => {
      const logs = logsContext.logs;
      const signature = logsContext.signature;

      for (const log of logs) {
        if (log.includes('ApplicationSubmittedEvent')) {
          console.log(`\n[EVENT DETECTED] New Applicant in Tx: ${signature}`);
          await notificationService.broadcastDiscordAlert(
            'New Application Submitted',
            `A builder has entered the Rumbo a Breakpoint challenge!\nTx: \`https://explorer.solana.com/tx/${signature}?cluster=devnet\``
          );
        } else if (log.includes('MilestoneAttestedEvent')) {
          console.log(`\n[EVENT DETECTED] Milestone Attested in Tx: ${signature}`);
          await notificationService.broadcastDiscordAlert(
            'Milestone Approved by Council',
            `Council multi-sig attested a grantee milestone.\nTx: \`https://explorer.solana.com/tx/${signature}?cluster=devnet\``,
            0x9945ff
          );
        } else if (log.includes('TrancheClaimedEvent')) {
          console.log(`\n[EVENT DETECTED] Tranche Claimed in Tx: ${signature}`);
          await notificationService.broadcastDiscordAlert(
            'Travel Grant Funds Withdrawn',
            `Grantee claimed milestone funds for flight/ticket.\nTx: \`https://explorer.solana.com/tx/${signature}?cluster=devnet\``,
            0x00c853
          );
          // Trigger automated email verification
          await notificationService.sendEmail({
            to: process.env.ADMIN_NOTIFY_EMAIL || 'builder@breakpoint2026.xyz',
            subject: 'Rumbo a Breakpoint 2026: Grant Funds Disbursed!',
            htmlContent: `<h2>¡Felicidades!</h2><p>Tus fondos de viáticos para <strong>Solana Breakpoint 2026</strong> han sido liberados en la transacción <a href="https://solscan.io/tx/${signature}?cluster=devnet">${signature}</a>.</p>`,
          });
        }
      }
    },
    'confirmed'
  );

  // Keep alive
  setInterval(() => {
    // Heartbeat log
  }, 60000);
}

main().catch((err) => {
  console.error('Fatal runtime failure in orchestrator:', err);
  process.exit(1);
});