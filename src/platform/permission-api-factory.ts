/**
 * Permission API Factory
 *
 * Creates platform-specific permission API implementations based on platform type.
 * This isolates platform selection logic to the platform layer.
 */

import type { PermissionApi, PermissionApiConfig } from './permission-api.js';
import { createMattermostPermissionApi } from './mattermost/permission-api.js';

/**
 * Create a permission API instance for the specified platform type
 */
export function createPermissionApi(
  platformType: string,
  config: PermissionApiConfig
): PermissionApi {
  switch (platformType) {
    case 'mattermost':
      return createMattermostPermissionApi(config);
    // TODO: Add Slack support
    // case 'slack':
    //   return createSlackPermissionApi(config);
    default:
      throw new Error(`Unsupported platform type: ${platformType}`);
  }
}
