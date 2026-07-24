import express from 'express';
import rbacService from '../../services/rbac.service.js';
import { requirePermission } from '../../middleware/auth.js';

const router = express.Router();

// List roles with permissions
router.get(
  '/roles',
  requirePermission('rbac.manage_roles'),
  async (req, res, next) => {
    try {
      const roles = await rbacService.listRoles();
      res.json({ status: 'success', data: roles });
    } catch (error) {
      next(error);
    }
  }
);

// Update role permissions
router.put(
  '/roles/:roleName/permissions',
  requirePermission('rbac.manage_roles'),
  async (req, res, next) => {
    try {
      const { roleName } = req.params;
      const { permissions = [] } = req.body;
      await rbacService.setRolePermissions(roleName, permissions);
      res.json({ status: 'success', message: 'Permissions updated' });
    } catch (error) {
      next(error);
    }
  }
);

// List permissions
router.get(
  '/permissions',
  requirePermission('rbac.manage_roles'),
  async (req, res, next) => {
    try {
      const permissions = await rbacService.listPermissions();
      res.json({ status: 'success', data: permissions });
    } catch (error) {
      next(error);
    }
  }
);

// List users with roles
router.get(
  '/users',
  requirePermission('rbac.assign_roles'),
  async (req, res, next) => {
    try {
      const users = await rbacService.listUsersWithRoles();
      res.json({ status: 'success', data: users });
    } catch (error) {
      next(error);
    }
  }
);

// Assign role to user
router.put(
  '/users/:userId/role',
  requirePermission('rbac.assign_roles'),
  async (req, res, next) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const { role } = req.body;
      await rbacService.assignRole(userId, role, req.user?.id);
      res.json({ status: 'success', message: 'Role assigned' });
    } catch (error) {
      next(error);
    }
  }
);

// Create a new local-auth user (email/password) with a role, in one step
router.post(
  '/users',
  requirePermission('rbac.assign_roles'),
  async (req, res, next) => {
    try {
      const { email, password, role } = req.body || {};
      if (!email || !password || password.length < 8) {
        return res.status(400).json({
          status: 'error',
          message: 'email and a password of at least 8 characters are required',
        });
      }
      if (!role) {
        return res.status(400).json({ status: 'error', message: 'role is required' });
      }

      const user = await rbacService.createUser(email, password, role, req.user?.id);
      res.status(201).json({ status: 'success', data: user });
    } catch (error) {
      next(error);
    }
  }
);

// Admin-driven password reset (no current-password check - admin is already authorized)
router.post(
  '/users/:userId/reset-password',
  requirePermission('rbac.assign_roles'),
  async (req, res, next) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const { newPassword } = req.body || {};
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({
          status: 'error',
          message: 'newPassword must be at least 8 characters',
        });
      }

      await rbacService.resetPassword(userId, newPassword);
      res.json({ status: 'success', message: 'Password reset' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
