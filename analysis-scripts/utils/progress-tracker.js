/**
 * Progress Tracker Utility
 * 
 * Manages progress state for long-running operations with resume capability.
 */

const fs = require('fs');
const path = require('path');

class ProgressTracker {
  constructor(progressFile, logger) {
    this.progressFile = progressFile;
    this.logger = logger;
    this.state = {
      startTime: null,
      lastUpdateTime: null,
      processedRows: 0,
      totalRows: 0,
      successCount: 0,
      errorCount: 0,
      skippedCount: 0,
      currentBatch: 0,
      errors: [],
      metadata: {}
    };
  }

  /**
   * Load progress from file if it exists
   * @returns {boolean} True if progress was loaded
   */
  load() {
    try {
      if (fs.existsSync(this.progressFile)) {
        const data = fs.readFileSync(this.progressFile, 'utf8');
        this.state = JSON.parse(data);
        
        this.logger.info(`Loaded progress: ${this.state.processedRows}/${this.state.totalRows} rows processed`);
        this.logger.info(`Success: ${this.state.successCount}, Errors: ${this.state.errorCount}, Skipped: ${this.state.skippedCount}`);
        
        return true;
      }
    } catch (error) {
      this.logger.warn(`Failed to load progress file: ${error.message}`);
    }
    
    return false;
  }

  /**
   * Initialize new progress tracking
   * @param {number} totalRows - Total number of rows to process
   * @param {object} metadata - Additional metadata to store
   */
  initialize(totalRows, metadata = {}) {
    this.state = {
      startTime: new Date().toISOString(),
      lastUpdateTime: new Date().toISOString(),
      processedRows: 0,
      totalRows,
      successCount: 0,
      errorCount: 0,
      skippedCount: 0,
      currentBatch: 0,
      errors: [],
      metadata
    };
    
    this.save();
    this.logger.info(`Initialized progress tracking for ${totalRows} rows`);
  }

  /**
   * Update progress for a processed row
   * @param {string} status - 'success', 'error', or 'skipped'
   * @param {object} details - Additional details about the row
   */
  update(status, details = {}) {
    this.state.processedRows++;
    this.state.lastUpdateTime = new Date().toISOString();

    switch (status) {
      case 'success':
        this.state.successCount++;
        break;
      case 'error':
        this.state.errorCount++;
        if (details.error) {
          this.state.errors.push({
            row: this.state.processedRows,
            error: details.error,
            timestamp: new Date().toISOString()
          });
        }
        break;
      case 'skipped':
        this.state.skippedCount++;
        break;
    }

    // Log progress at intervals
    if (this.state.processedRows % 10 === 0) {
      this.logger.progress(
        this.state.processedRows,
        this.state.totalRows,
        `Success: ${this.state.successCount}, Errors: ${this.state.errorCount}`
      );
    }
  }

  /**
   * Update current batch number
   * @param {number} batchNumber - Current batch number
   */
  updateBatch(batchNumber) {
    this.state.currentBatch = batchNumber;
  }

  /**
   * Save current progress to file
   */
  save() {
    try {
      const dir = path.dirname(this.progressFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(
        this.progressFile,
        JSON.stringify(this.state, null, 2),
        'utf8'
      );
    } catch (error) {
      this.logger.error(`Failed to save progress: ${error.message}`);
    }
  }

  /**
   * Check if processing should resume
   * @returns {boolean} True if there's progress to resume
   */
  shouldResume() {
    return this.state.processedRows > 0 && this.state.processedRows < this.state.totalRows;
  }

  /**
   * Get the next row index to process
   * @returns {number} Next row index
   */
  getNextRowIndex() {
    return this.state.processedRows;
  }

  /**
   * Get current progress percentage
   * @returns {number} Progress percentage (0-100)
   */
  getProgressPercentage() {
    if (this.state.totalRows === 0) return 0;
    return (this.state.processedRows / this.state.totalRows) * 100;
  }

  /**
   * Get estimated time remaining
   * @returns {string} Formatted time remaining
   */
  getEstimatedTimeRemaining() {
    if (this.state.processedRows === 0 || !this.state.startTime) {
      return 'Calculating...';
    }

    const startTime = new Date(this.state.startTime);
    const now = new Date();
    const elapsedMs = now - startTime;
    const rowsRemaining = this.state.totalRows - this.state.processedRows;
    const msPerRow = elapsedMs / this.state.processedRows;
    const estimatedMs = rowsRemaining * msPerRow;

    return this._formatDuration(estimatedMs);
  }

  /**
   * Get elapsed time
   * @returns {string} Formatted elapsed time
   */
  getElapsedTime() {
    if (!this.state.startTime) return '0s';
    
    const startTime = new Date(this.state.startTime);
    const now = new Date();
    const elapsedMs = now - startTime;

    return this._formatDuration(elapsedMs);
  }

  /**
   * Format duration in milliseconds to human-readable string
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get summary of progress
   * @returns {object} Progress summary
   */
  getSummary() {
    return {
      totalRows: this.state.totalRows,
      processedRows: this.state.processedRows,
      successCount: this.state.successCount,
      errorCount: this.state.errorCount,
      skippedCount: this.state.skippedCount,
      progressPercentage: this.getProgressPercentage().toFixed(1) + '%',
      elapsedTime: this.getElapsedTime(),
      estimatedTimeRemaining: this.getEstimatedTimeRemaining(),
      successRate: this.state.processedRows > 0 
        ? ((this.state.successCount / this.state.processedRows) * 100).toFixed(1) + '%'
        : '0%'
    };
  }

  /**
   * Clear progress file
   */
  clear() {
    try {
      if (fs.existsSync(this.progressFile)) {
        fs.unlinkSync(this.progressFile);
        this.logger.info('Progress file cleared');
      }
    } catch (error) {
      this.logger.error(`Failed to clear progress file: ${error.message}`);
    }
  }

  /**
   * Log final summary
   */
  logSummary() {
    const summary = this.getSummary();
    
    this.logger.complete('Processing Complete', {
      'Total Rows': summary.totalRows,
      'Processed': summary.processedRows,
      'Successful': summary.successCount,
      'Errors': summary.errorCount,
      'Skipped': summary.skippedCount,
      'Success Rate': summary.successRate,
      'Total Time': summary.elapsedTime
    });

    if (this.state.errorCount > 0 && this.state.errors.length > 0) {
      this.logger.warn('\nErrors encountered:');
      this.state.errors.slice(0, 10).forEach(err => {
        this.logger.warn(`  Row ${err.row}: ${err.error}`);
      });
      
      if (this.state.errors.length > 10) {
        this.logger.warn(`  ... and ${this.state.errors.length - 10} more errors`);
      }
    }
  }
}

module.exports = ProgressTracker;
