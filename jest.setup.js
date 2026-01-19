/**
 * Jest setup file
 *
 * Purpose: Configure global test environment settings
 * Runs before each test file
 *
 * Connects to: dotenv for loading environment variables from .env
 */

const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();
