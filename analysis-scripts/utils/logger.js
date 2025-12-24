/**
 * Logger Utility
 * 
 * Provides consistent logging across all scripts with levels, timestamps, and formatting.
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(config = {}) {
    this.level = config.level || 'info';
    this.includeTimestamp = config.includeTimestamp !== false;
    this.includeMetadata = config.includeMetadata !== false;
    this.colorize = config.colorize !== false;
    this.logDir = config.logDir || './logs';
    this.logToFile = config.logToFile !== false;
    
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };

    this.colors = {
      debug: '\x1b[36m', // Cyan
      info: '\x1b[32m',  // Green
      warn: '\x1b[33m',  // Yellow
      error: '\x1b[31m', // Red
      reset: '\x1b[0m'
    };

    // Create log directory if it doesn't exist
    if (this.logToFile && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  _shouldLog(level) {
    return this.levels[level] >= this.levels[this.level];
  }

  _formatMessage(level, message, metadata = {}) {
    let formatted = '';

    if (this.includeTimestamp) {
      formatted += `[${new Date().toISOString()}] `;
    }

    formatted += `[${level.toUpperCase()}] ${message}`;

    if (this.includeMetadata && Object.keys(metadata).length > 0) {
      formatted += ` ${JSON.stringify(metadata)}`;
    }

    return formatted;
  }

  _colorize(level, message) {
    if (!this.colorize) return message;
    return `${this.colors[level]}${message}${this.colors.reset}`;
  }

  _writeToFile(level, message) {
    if (!this.logToFile) return;

    const logFile = path.join(this.logDir, `${new Date().toISOString().split('T')[0]}.log`);
    const logEntry = this._formatMessage(level, message) + '\n';

    try {
      fs.appendFileSync(logFile, logEntry);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  debug(message, metadata = {}) {
    if (!this._shouldLog('debug')) return;
    
    const formatted = this._formatMessage('debug', message, metadata);
    console.log(this._colorize('debug', formatted));
    this._writeToFile('debug', message);
  }

  info(message, metadata = {}) {
    if (!this._shouldLog('info')) return;
    
    const formatted = this._formatMessage('info', message, metadata);
    console.log(this._colorize('info', formatted));
    this._writeToFile('info', message);
  }

  warn(message, metadata = {}) {
    if (!this._shouldLog('warn')) return;
    
    const formatted = this._formatMessage('warn', message, metadata);
    console.warn(this._colorize('warn', formatted));
    this._writeToFile('warn', message);
  }

  error(message, metadata = {}) {
    if (!this._shouldLog('error')) return;
    
    const formatted = this._formatMessage('error', message, metadata);
    console.error(this._colorize('error', formatted));
    this._writeToFile('error', message);
  }

  // Special methods for progress tracking
  progress(current, total, message = '') {
    const percentage = ((current / total) * 100).toFixed(1);
    const progressBar = this._createProgressBar(current, total);
    const formattedMessage = `Progress: ${progressBar} ${percentage}% (${current}/${total}) ${message}`;
    
    if (this._shouldLog('info')) {
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      process.stdout.write(this._colorize('info', formattedMessage));
    }
  }

  _createProgressBar(current, total, width = 30) {
    const filled = Math.floor((current / total) * width);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${' '.repeat(empty)}]`;
  }

  // Method to log completion with summary
  complete(message, stats = {}) {
    this.info('\n' + '='.repeat(60));
    this.info(message);
    
    if (Object.keys(stats).length > 0) {
      this.info('Summary:');
      for (const [key, value] of Object.entries(stats)) {
        this.info(`  ${key}: ${value}`);
      }
    }
    
    this.info('='.repeat(60));
  }

  // Method for section headers
  section(title) {
    this.info('\n' + '='.repeat(60));
    this.info(title);
    this.info('='.repeat(60));
  }
}

module.exports = Logger;
