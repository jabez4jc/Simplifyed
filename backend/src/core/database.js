/**
 * Database Layer
 * Provides a clean Promise-based interface for SQLite operations
 */

import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import config from './config.js';
import { log } from './logger.js';
import { DatabaseError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure database directory exists
const dbPath = join(__dirname, '../../', config.database.path);
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

/**
 * Database class with Promise-based methods
 */
class Database {
  constructor() {
    this.db = null;
    this.isConnected = false;
  }

  /**
   * Initialize database connection
   */
  async connect() {
    if (this.isConnected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          log.error('Failed to connect to database', err);
          reject(new DatabaseError('Failed to connect to database', err));
        } else {
          this.db = db;
          this.isConnected = true;
          log.info('Database connected', { path: dbPath });

          // Enable foreign keys
          this.db.run('PRAGMA foreign_keys = ON');

          // Set journal mode to WAL for better concurrency
          this.db.run('PRAGMA journal_mode = WAL');

          resolve();
        }
      });
    });
  }

  /**
   * Close database connection
   */
  async close() {
    if (!this.isConnected || !this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          log.error('Failed to close database', err);
          reject(new DatabaseError('Failed to close database', err));
        } else {
          this.isConnected = false;
          this.db = null;
          log.info('Database closed');
          resolve();
        }
      });
    });
  }

  /**
   * Run a SQL query (INSERT, UPDATE, DELETE)
   * @returns {Promise<{lastID: number, changes: number}>}
   */
  async run(sql, params = []) {
    this._ensureConnected();

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        const duration = Date.now() - startTime;

        if (err) {
          log.error('Database query failed', err, { sql, params });
          reject(new DatabaseError(err.message, err));
        } else {
          log.query(sql, params, duration);
          resolve({
            lastID: this.lastID,
            changes: this.changes,
          });
        }
      });
    });
  }

  /**
   * Get a single row
   * @returns {Promise<Object|null>}
   */
  async get(sql, params = []) {
    this._ensureConnected();

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        const duration = Date.now() - startTime;

        if (err) {
          log.error('Database query failed', err, { sql, params });
          reject(new DatabaseError(err.message, err));
        } else {
          log.query(sql, params, duration);
          resolve(row || null);
        }
      });
    });
  }

  /**
   * Get all matching rows
   * @returns {Promise<Array>}
   */
  async all(sql, params = []) {
    this._ensureConnected();

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        const duration = Date.now() - startTime;

        if (err) {
          log.error('Database query failed', err, { sql, params });
          reject(new DatabaseError(err.message, err));
        } else {
          log.query(sql, params, duration);
          resolve(rows || []);
        }
      });
    });
  }

  /**
   * Execute multiple queries in a transaction
   * @param {Function} callback - Async function that performs queries
   */
  async transaction(callback) {
    this._ensureConnected();

    try {
      await this.run('BEGIN TRANSACTION');
      const result = await callback(this);
      await this.run('COMMIT');
      return result;
    } catch (error) {
      await this.run('ROLLBACK');
      throw error;
    }
  }

  /**
   * Ensure database is connected
   * @private
   */
  _ensureConnected() {
    if (!this.isConnected || !this.db) {
      throw new DatabaseError('Database not connected');
    }
  }
}

// Create singleton instance
const db = new Database();

export default db;
export { Database };
