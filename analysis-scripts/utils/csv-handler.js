/**
 * CSV Handler Utility
 * 
 * Provides consistent CSV reading, writing, and manipulation across all scripts.
 */

const fs = require('fs');
const Papa = require('papaparse');

class CSVHandler {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Read CSV file and return parsed data
   * @param {string} filePath - Path to CSV file
   * @param {object} options - Parsing options
   * @returns {Promise<Array>} Parsed data
   */
  async read(filePath, options = {}) {
    try {
      this.logger.info(`Reading CSV file: ${filePath}`);
      
      const fileContent = fs.readFileSync(filePath, 'utf8');
      
      const parseResult = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true,
        transformHeader: options.transformHeader || undefined,
        ...options
      });

      if (parseResult.errors.length > 0) {
        this.logger.warn(`CSV parsing warnings: ${parseResult.errors.length} errors found`);
        parseResult.errors.forEach(error => {
          this.logger.debug(`Parse error at row ${error.row}: ${error.message}`);
        });
      }

      this.logger.info(`Successfully parsed ${parseResult.data.length} rows`);
      return parseResult.data;
    } catch (error) {
      this.logger.error(`Failed to read CSV file: ${error.message}`);
      throw error;
    }
  }

  /**
   * Write data to CSV file
   * @param {string} filePath - Path to output file
   * @param {Array} data - Data to write
   * @param {object} options - Write options
   */
  async write(filePath, data, options = {}) {
    try {
      this.logger.info(`Writing CSV file: ${filePath}`);
      
      const csv = Papa.unparse(data, {
        quotes: options.quotes !== false,
        delimiter: options.delimiter || ',',
        header: options.header !== false,
        newline: options.newline || '\n',
        ...options
      });

      fs.writeFileSync(filePath, csv, 'utf8');
      this.logger.info(`Successfully wrote ${data.length} rows to ${filePath}`);
    } catch (error) {
      this.logger.error(`Failed to write CSV file: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create backup of CSV file
   * @param {string} filePath - Path to file to backup
   * @returns {string} Path to backup file
   */
  backup(filePath) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = filePath.replace(/\.csv$/, `_backup_${timestamp}.csv`);
      
      fs.copyFileSync(filePath, backupPath);
      this.logger.info(`Created backup: ${backupPath}`);
      
      return backupPath;
    } catch (error) {
      this.logger.error(`Failed to create backup: ${error.message}`);
      throw error;
    }
  }

  /**
   * Validate required columns exist in data
   * @param {Array} data - CSV data
   * @param {Array<string>} requiredColumns - Column names that must exist
   * @throws {Error} If required columns are missing
   */
  validateColumns(data, requiredColumns) {
    if (!data || data.length === 0) {
      throw new Error('CSV data is empty');
    }

    const columns = Object.keys(data[0]);
    const missingColumns = requiredColumns.filter(col => !columns.includes(col));

    if (missingColumns.length > 0) {
      throw new Error(`Missing required columns: ${missingColumns.join(', ')}`);
    }

    this.logger.debug(`All required columns present: ${requiredColumns.join(', ')}`);
    return true;
  }

  /**
   * Filter rows based on condition function
   * @param {Array} data - CSV data
   * @param {Function} condition - Filter function
   * @returns {Array} Filtered data
   */
  filter(data, condition) {
    const filtered = data.filter(condition);
    this.logger.debug(`Filtered ${data.length} rows to ${filtered.length} rows`);
    return filtered;
  }

  /**
   * Get unique values from a column
   * @param {Array} data - CSV data
   * @param {string} columnName - Column to extract unique values from
   * @returns {Array} Unique values
   */
  getUniqueValues(data, columnName) {
    const values = data.map(row => row[columnName]).filter(val => val);
    const unique = [...new Set(values)];
    this.logger.debug(`Found ${unique.length} unique values in column '${columnName}'`);
    return unique;
  }

  /**
   * Group rows by column value
   * @param {Array} data - CSV data
   * @param {string} columnName - Column to group by
   * @returns {Object} Grouped data
   */
  groupBy(data, columnName) {
    const grouped = {};
    
    data.forEach(row => {
      const key = row[columnName];
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(row);
    });

    this.logger.debug(`Grouped data into ${Object.keys(grouped).length} groups by '${columnName}'`);
    return grouped;
  }

  /**
   * Add or update column in data
   * @param {Array} data - CSV data
   * @param {string} columnName - Column to add/update
   * @param {Function|*} valueOrFunction - Value or function to generate value
   * @returns {Array} Updated data
   */
  addColumn(data, columnName, valueOrFunction) {
    return data.map((row, index) => {
      const value = typeof valueOrFunction === 'function' 
        ? valueOrFunction(row, index)
        : valueOrFunction;
      
      return { ...row, [columnName]: value };
    });
  }

  /**
   * Remove columns from data
   * @param {Array} data - CSV data
   * @param {Array<string>} columnsToRemove - Columns to remove
   * @returns {Array} Data without specified columns
   */
  removeColumns(data, columnsToRemove) {
    return data.map(row => {
      const newRow = { ...row };
      columnsToRemove.forEach(col => delete newRow[col]);
      return newRow;
    });
  }

  /**
   * Rename columns in data
   * @param {Array} data - CSV data
   * @param {Object} columnMapping - Object mapping old names to new names
   * @returns {Array} Data with renamed columns
   */
  renameColumns(data, columnMapping) {
    return data.map(row => {
      const newRow = {};
      Object.keys(row).forEach(key => {
        const newKey = columnMapping[key] || key;
        newRow[newKey] = row[key];
      });
      return newRow;
    });
  }

  /**
   * Get statistics about CSV data
   * @param {Array} data - CSV data
   * @returns {Object} Statistics
   */
  getStats(data) {
    if (!data || data.length === 0) {
      return { rows: 0, columns: 0 };
    }

    const columns = Object.keys(data[0]);
    const stats = {
      rows: data.length,
      columns: columns.length,
      columnNames: columns,
      emptyRows: data.filter(row => {
        return Object.values(row).every(val => !val || val.trim() === '');
      }).length
    };

    this.logger.debug('CSV Statistics:', stats);
    return stats;
  }
}

module.exports = CSVHandler;
