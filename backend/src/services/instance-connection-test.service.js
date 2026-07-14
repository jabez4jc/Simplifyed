/**
 * Instance Connection Test Service
 * Ping/funds-based connectivity and API key validation for OpenAlgo instances.
 * Extracted from instance.service.js - stateless, called by createInstance/updateInstance
 * before persisting credentials, and directly by the instances API for the "test connection"
 * UI action.
 */

import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { normalizeUrl, sanitizeApiKey } from '../utils/sanitizers.js';

class InstanceConnectionTestService {
  /**
   * Test connection to OpenAlgo instance (using ping endpoint)
   * @param {Object} credentials - { host_url, api_key }
   * @returns {Promise<Object>} - { success, broker, message }
   */
  async testConnection(credentials) {
    try {
      const { host_url, api_key } = credentials;

      if (!host_url || !api_key) {
        return {
          success: false,
          message: 'Host URL and API key are required',
        };
      }

      // Create temporary instance object for testing
      const tempInstance = {
        host_url: normalizeUrl(host_url),
        api_key: sanitizeApiKey(api_key),
      };

      // Call ping endpoint to test connection and get broker name
      // Note: ping() already returns response.data, not the full response
      const pingData = await openalgoClient.ping(tempInstance);

      log.debug('Ping response received', {
        host_url: tempInstance.host_url,
        pingData,
      });

      // Check for broker in the response (pingData is already response.data)
      if (pingData && pingData.broker) {
        log.info('Connection test successful', {
          host_url: tempInstance.host_url,
          broker: pingData.broker,
        });

        return {
          success: true,
          broker: pingData.broker,
          message: pingData.message || 'Connection successful',
        };
      }

      // Log the full response to help debug
      log.warn('Broker information not found in ping response', {
        host_url: tempInstance.host_url,
        pingData,
      });

      return {
        success: false,
        message: 'Ping successful but broker information not found in response',
      };
    } catch (error) {
      log.warn('Connection test failed', { error: error.message });
      return {
        success: false,
        message: error.message || 'Failed to connect to OpenAlgo instance',
      };
    }
  }

  /**
   * Test API key validity (using funds endpoint)
   * @param {Object} credentials - { host_url, api_key }
   * @returns {Promise<Object>} - { success, message, funds }
   */
  async testApiKey(credentials) {
    try {
      const { host_url, api_key } = credentials;

      if (!host_url || !api_key) {
        return {
          success: false,
          message: 'Host URL and API key are required',
        };
      }

      // Create temporary instance object for testing
      const tempInstance = {
        host_url: normalizeUrl(host_url),
        api_key: sanitizeApiKey(api_key),
      };

      // Call funds endpoint to validate API key
      // Note: getFunds() already returns response.data, not the full response
      const fundsData = await openalgoClient.getFunds(tempInstance);

      log.debug('Funds response received', {
        host_url: tempInstance.host_url,
        fundsData,
      });

      if (fundsData) {
        log.info('API key test successful', {
          host_url: tempInstance.host_url,
        });

        return {
          success: true,
          message: 'API key is valid',
          funds: fundsData,
        };
      }

      return {
        success: false,
        message: 'Invalid API key or funds data not available',
      };
    } catch (error) {
      log.warn('API key test failed', { error: error.message });
      return {
        success: false,
        message: error.message || 'Invalid API key',
      };
    }
  }
}

const instanceConnectionTestService = new InstanceConnectionTestService();
export default instanceConnectionTestService;
export { InstanceConnectionTestService };
