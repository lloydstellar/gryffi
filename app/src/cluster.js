/**
 * Gryffi Cluster Manager
 * 
 * Entry point for production deployments with multiple workers.
 * Uses Node.js built-in cluster module for multi-core utilization.
 * 
 * Environment variables:
 * - CLUSTER_ENABLED: Set to 'true' to enable clustering (default: false)
 * - CLUSTER_WORKERS: Number of workers, 'auto' for CPU count (default: auto)
 * 
 * In development (CLUSTER_ENABLED=false), this file simply loads server.js directly.
 * In production (CLUSTER_ENABLED=true), it spawns multiple workers.
 */

import cluster from 'cluster';
import os from 'os';

const isClusterEnabled = process.env.CLUSTER_ENABLED === 'true';
const workerCount = process.env.CLUSTER_WORKERS === 'auto' || !process.env.CLUSTER_WORKERS
  ? os.cpus().length
  : parseInt(process.env.CLUSTER_WORKERS) || os.cpus().length;

if (!isClusterEnabled) {
  // Clustering disabled - run single process (development mode)
  console.log('🔧 Clustering disabled - running in single process mode');
  import('./server.js');
} else if (cluster.isPrimary) {
  // Primary process - manage workers
  console.log(`\n🚀 Gryffi Cluster Manager`);
  console.log(`📊 Starting ${workerCount} workers on ${os.cpus().length} CPU cores`);
  console.log(`💾 Total memory: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}\n`);

  // Fork workers
  for (let i = 0; i < workerCount; i++) {
    const worker = cluster.fork({ WORKER_ID: i });
    console.log(`  ├─ Worker ${i + 1}/${workerCount} started (PID: ${worker.process.pid})`);
  }

  console.log(`  └─ All workers started\n`);

  // Handle worker crashes - restart automatically
  cluster.on('exit', (worker, code, signal) => {
    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`⚠️  Worker ${worker.process.pid} died (${exitReason}). Restarting...`);
    
    // Restart the worker after a brief delay to prevent rapid restart loops
    setTimeout(() => {
      const newWorker = cluster.fork({ WORKER_ID: worker.id });
      console.log(`  └─ Replacement worker started (PID: ${newWorker.process.pid})`);
    }, 1000);
  });

  // Graceful shutdown handling
  const shutdown = (signal) => {
    console.log(`\n🛑 ${signal} received - shutting down gracefully...`);
    
    // Give workers 10 seconds to finish current requests
    const timeout = setTimeout(() => {
      console.log('⏱️  Timeout reached, forcing shutdown');
      process.exit(1);
    }, 10000);

    let workersExited = 0;
    const totalWorkers = Object.keys(cluster.workers).length;

    for (const id in cluster.workers) {
      cluster.workers[id].kill('SIGTERM');
    }

    cluster.on('exit', () => {
      workersExited++;
      if (workersExited === totalWorkers) {
        clearTimeout(timeout);
        console.log('✅ All workers shut down gracefully');
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start scheduler only on primary process (not workers)
  // This prevents duplicate scheduled tasks
  console.log('📅 Starting scheduler on primary process...');
  import('./services/scheduler.js').then(({ startScheduler }) => {
    startScheduler();
  });

} else {
  // Worker process - handle HTTP requests
  const workerId = process.env.WORKER_ID || cluster.worker.id;
  console.log(`👷 Worker ${workerId} (PID: ${process.pid}) starting...`);
  
  // Import server but skip scheduler (handled by primary)
  process.env.SKIP_SCHEDULER = 'true';
  import('./server.js');
}
