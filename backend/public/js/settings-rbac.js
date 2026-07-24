/**
 * Simplifyed Admin V2 - Settings: RBAC / Access Control tab.
 */

Object.defineProperties(SettingsHandler.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render Access Control tab (RBAC)
   */
  renderAccessControlTab() {
    if (!this.isAdmin()) {
      return `
        <div class="card">
          <div class="p-6">
            <p class="text-neutral-600 text-sm">
              You don't have permission to access this section. Admin access required.
            </p>
          </div>
        </div>
      `;
    }

    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🔐 Role & User Access</h3>
          <p class="text-sm text-neutral-600 mt-1">Assign role permissions and control user access.</p>
        </div>
        <div class="p-6" id="rbac-root">
          ${this.renderRbacSection()}
        </div>
      </div>
    `;
  }
  async fetchRbacData() {
    try {
      const [rolesRes, usersRes, permsRes] = await Promise.all([
        this.authFetch('/api/v1/rbac/roles'),
        this.authFetch('/api/v1/rbac/users'),
        this.authFetch('/api/v1/rbac/permissions'),
      ]);
      const rolesJson = await rolesRes.json();
      const usersJson = await usersRes.json();
      const permsJson = await permsRes.json();
      this.roles = rolesJson?.data || [];
      this.users = usersJson?.data || [];
      this.permissions = permsJson?.data || [];
    } catch (e) {
      console.error('Failed to load RBAC data', e);
    }
  }

  renderRbacSection() {
    if (!this.roles || !this.users) {
      return '<p class="text-sm text-neutral-600">Loading...</p>';
    }
    if (!this.activeRoleTab && this.roles.length > 0) {
      this.activeRoleTab = this.roles[0].name;
    }
    const roleOptions = this.roles.map(r => `<option value="${r.name}" ${r.name === this.activeRoleTab ? 'selected' : ''}>${r.name}</option>`).join('');
    const activeRolePanel = this.renderRolePermissionsPanel(this.activeRoleTab);

    return `
      <div class="space-y-3">
        <div class="grid lg:grid-cols-3 gap-3">
          <div class="lg:col-span-2 card border border-base-200 bg-base-100">
            <div class="card-header flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <h4 class="font-semibold">Role Permissions</h4>
                <p class="text-xs text-neutral-500">Select a role and adjust permissions.</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <div class="flex items-center gap-2 bg-base-200 rounded-full px-2 py-1 rbac-pill-row">
                  <span class="text-[11px] uppercase tracking-wide text-neutral-500">Role</span>
                  <select class="select select-xs border-0 bg-transparent focus:outline-none rbac-role-select-pill" onchange="settings.switchRoleTab(this.value)">
                    ${roleOptions}
                  </select>
                </div>
                <label class="flex items-center gap-2 bg-base-200 rounded-full px-2 py-1 rbac-pill-row">
                  <span class="text-[11px] uppercase tracking-wide text-neutral-500">Filter</span>
                  <input
                    type="text"
                    class="input input-xs border-0 bg-transparent focus:outline-none w-36 rbac-filter-pill"
                    placeholder="permissions"
                    value="${Utils.escapeHTML(this.permissionFilter || '')}"
                    oninput="settings.handlePermissionFilter(this.value)"
                  />
                </label>
              </div>
            </div>
            <div class="p-3" id="rbac-role-panel">
              ${activeRolePanel}
            </div>
          </div>
          <div class="lg:col-span-1 card border border-base-200 bg-base-100">
            <div class="card-header py-3 flex items-center justify-between gap-2">
              <div>
                <h4 class="font-semibold">Users & Roles</h4>
                <p class="text-xs text-neutral-500">Assign access by role.</p>
              </div>
              <button class="btn btn-xs btn-primary" onclick="settings.showCreateUserModal()">
                Create User
              </button>
            </div>
            <div class="p-3">
              ${this.renderUserAssignments()}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderUserAssignments() {
    const roleFilterOptions = ['all', ...this.roles.map(r => r.name)];
    const roleFilterHtml = roleFilterOptions.map((role) => `
      <option value="${role}" ${role === this.userRoleFilter ? 'selected' : ''}>${role === 'all' ? 'All roles' : role}</option>
    `).join('');

    const filteredUsers = this.users.filter((u) => {
      const email = (u.email || '').toLowerCase();
      const role = (u.role || '').toLowerCase();
      const filter = (this.userFilter || '').toLowerCase();
      const roleFilter = this.userRoleFilter;
      const matchesRole = roleFilter === 'all' || role === roleFilter.toLowerCase();
      const matchesSearch = !filter || email.includes(filter) || role.includes(filter);
      return matchesRole && matchesSearch;
    });

    const rows = filteredUsers.map(u => {
      const options = this.roles.map(r => `<option value="${r.name}" ${r.name === u.role ? 'selected' : ''}>${r.name}</option>`).join('');
      return `
        <tr>
          <td class="py-2 px-2">${Utils.escapeHTML(u.email)}</td>
          <td class="py-2 px-2">${Utils.escapeHTML(u.role || '—')}</td>
          <td class="py-2 px-2">
            <select data-user-id="${u.id}" class="select select-sm rbac-role-select">
              ${options}
            </select>
          </td>
          <td class="py-2 px-2">
            <button class="btn btn-xs btn-outline" onclick="settings.showResetPasswordModal(${u.id}, '${Utils.escapeHTML(u.email)}')">
              Reset Password
            </button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="space-y-2">
        <div class="grid grid-cols-1 gap-2">
          <input
            type="text"
            class="input input-bordered input-xs"
            placeholder="Search users"
            value="${Utils.escapeHTML(this.userFilter || '')}"
            oninput="settings.handleUserFilter(this.value)"
          />
          <select class="select select-xs" onchange="settings.handleUserRoleFilter(this.value)">
            ${roleFilterHtml}
          </select>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Email</th>
                <th>Current Role</th>
                <th>Assign Role</th>
                <th>Password</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="4" class="text-center text-neutral-500">No users found.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  renderRolePermissionsPanel(roleName) {
    const role = this.roles.find(r => r.name === roleName);
    if (!role) {
      return '<p class="text-sm text-neutral-600">Select a role to manage permissions.</p>';
    }
    const currentPerms = new Set(role.permissions || []);
    const filter = (this.permissionFilter || '').toLowerCase();
    const permissions = this.permissions.filter(p => !filter || p.key.toLowerCase().includes(filter));
    const grouped = permissions.reduce((acc, perm) => {
      const group = perm.key.split('.')[0];
      acc[group] = acc[group] || [];
      acc[group].push(perm);
      return acc;
    }, {});

    const groupLabels = {
      pages: 'Pages',
      orders: 'Orders',
      positions: 'Positions',
      watchlists: 'Watchlists',
      instances: 'Instances',
      settings: 'Settings',
      rbac: 'RBAC',
      marketdata: 'Market Data',
      monitor: 'Monitoring',
    };

    const allPerms = role.permissions || [];
    const viewCount = allPerms.filter((p) => p.endsWith('.view')).length;
    const editCount = allPerms.filter((p) => p.endsWith('.edit') || p.endsWith('.manage') || p.endsWith('.place') || p.endsWith('.cancel')).length;

    const groupBlocks = Object.keys(grouped).sort().map((group) => {
      const label = groupLabels[group] || group.toUpperCase();
      const checks = grouped[group].map(p => {
        const checked = currentPerms.has(p.key);
        const pillClass = checked ? 'btn-primary' : 'btn-outline';
        return `
        <label class="btn btn-xs ${pillClass} rounded-full rbac-pill px-2">
          <input type="checkbox" class="rbac-perm-checkbox hidden"
            data-role="${role.name}" data-perm="${p.key}"
            ${checked ? 'checked' : ''}>
          <span class="text-xs">${Utils.escapeHTML(p.key)}</span>
        </label>
        `;
      }).join('');
      const checkedCount = grouped[group].filter(p => currentPerms.has(p.key)).length;
      return `
        <details class="border rounded-lg rbac-group">
          <summary class="cursor-pointer select-none flex items-center justify-between gap-2 px-2 py-2 text-xs rbac-accordion-strip">
            <span class="font-semibold">${Utils.escapeHTML(label)}</span>
            <span class="text-xs text-neutral-500">${checkedCount}/${grouped[group].length}</span>
          </summary>
          <div class="px-2 pb-2">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-1">
              ${checks}
            </div>
          </div>
        </details>
      `;
    }).join('');

    return `
      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="font-semibold text-base">${Utils.escapeHTML(role.name)}</div>
            <div class="text-xs text-neutral-500">Total: ${allPerms.length} · View: ${viewCount} · Edit: ${editCount}</div>
          </div>
          <div class="flex gap-1 flex-wrap">
            <button class="btn btn-xs btn-outline" onclick="settings.togglePermissionGroups(true)">Expand all</button>
            <button class="btn btn-xs btn-outline" onclick="settings.togglePermissionGroups(false)">Collapse all</button>
            <button class="btn btn-xs btn-primary rbac-save-perms" data-role="${role.name}">Save</button>
          </div>
        </div>
        <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3 max-h-[24rem] overflow-auto">
          ${groupBlocks || '<p class="text-sm text-neutral-500">No permissions match the filter.</p>'}
        </div>
      </div>
    `;
  }

  showCreateUserModal() {
    const roleOptions = this.roles.map(r => `<option value="${Utils.escapeHTML(r.name)}">${Utils.escapeHTML(r.name)}</option>`).join('');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Create User</h3>
        </div>
        <div class="modal-body">
          <form id="create-user-form">
            <div class="form-group">
              <label class="form-label">Email *</label>
              <input type="email" name="email" class="form-input" required autocomplete="off">
            </div>
            <div class="form-group">
              <label class="form-label">Password *</label>
              <input type="password" name="password" class="form-input" minlength="8" required autocomplete="new-password">
              <p class="text-xs text-neutral-500 mt-1">At least 8 characters.</p>
            </div>
            <div class="form-group">
              <label class="form-label">Role *</label>
              <select name="role" class="form-input" required>
                ${roleOptions}
              </select>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="Utils.closeModal(this)">Cancel</button>
          <button class="btn btn-buy" onclick="settings.submitCreateUser()">Create</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  async submitCreateUser() {
    const form = document.getElementById('create-user-form');
    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await this.authFetch('/api/v1/rbac/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || 'Failed to create user');
      }
      Utils.closeModal(document.querySelector('.modal-overlay'), { checkDirty: false });
      Utils.showToast(`User ${data.email} created`, 'success');
      await this.fetchRbacData();
      this.refreshRbacSection();
    } catch (err) {
      Utils.showToast(err.message, 'error');
    }
  }

  showResetPasswordModal(userId, email) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Reset Password</h3>
        </div>
        <div class="modal-body">
          <p class="text-sm text-neutral-600 mb-2">Set a new password for <strong></strong>.</p>
          <form id="reset-password-form">
            <div class="form-group">
              <label class="form-label">New Password *</label>
              <input type="password" name="newPassword" class="form-input" minlength="8" required autocomplete="new-password">
              <p class="text-xs text-neutral-500 mt-1">At least 8 characters.</p>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="Utils.closeModal(this)">Cancel</button>
          <button class="btn btn-buy" onclick="settings.submitResetPassword(${userId})">Reset</button>
        </div>
      </div>
    `;
    // Set via textContent (not interpolated into the innerHTML template) so an email containing
    // markup can never inject into the modal - same convention as Utils.confirm().
    modal.querySelector('.modal-body strong').textContent = email;
    document.body.appendChild(modal);
  }

  async submitResetPassword(userId) {
    const form = document.getElementById('reset-password-form');
    const data = Object.fromEntries(new FormData(form).entries());

    try {
      const res = await this.authFetch(`/api/v1/rbac/users/${userId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || 'Failed to reset password');
      }
      Utils.closeModal(document.querySelector('.modal-overlay'), { checkDirty: false });
      Utils.showToast('Password reset', 'success');
    } catch (err) {
      Utils.showToast(err.message, 'error');
    }
  }

  handlePermissionFilter(value) {
    this.permissionFilter = value || '';
    this.refreshRbacSection();
  }

  handleUserFilter(value) {
    this.userFilter = value || '';
    this.refreshRbacSection();
  }

  handleUserRoleFilter(value) {
    this.userRoleFilter = value || 'all';
    this.refreshRbacSection();
  }

  toggleRolePermissions(roleName, enabled) {
    const checks = document.querySelectorAll(`.rbac-perm-checkbox[data-role="${roleName}"]`);
    checks.forEach((checkbox) => {
      checkbox.checked = enabled;
      const pill = checkbox.closest('.rbac-pill');
      if (pill) {
        pill.classList.toggle('btn-primary', enabled);
        pill.classList.toggle('btn-outline', !enabled);
      }
    });
  }

  togglePermissionGroups(expand) {
    const groups = document.querySelectorAll('#rbac-role-panel details');
    groups.forEach((group) => {
      if (expand) {
        group.setAttribute('open', '');
      } else {
        group.removeAttribute('open');
      }
    });
  }

  refreshRbacSection() {
    const root = document.getElementById('rbac-root');
    if (!root) return;
    root.innerHTML = this.renderRbacSection();
    this.initRbacListeners();
  }

  switchRoleTab(roleName) {
    this.activeRoleTab = roleName;
    const panel = document.getElementById('rbac-role-panel');
    if (panel) {
      panel.innerHTML = this.renderRolePermissionsPanel(roleName);
    }
    document.querySelectorAll('.rbac-role-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-role') === roleName);
    });
    this.initRbacListeners();
  }

  initRbacListeners() {
    document.querySelectorAll('.rbac-role-select').forEach((select) => {
      select.addEventListener('change', async (e) => {
        const userId = e.target.getAttribute('data-user-id');
        const role = e.target.value;
        try {
          const res = await this.authFetch(`/api/v1/rbac/users/${userId}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role }),
          });
          if (!res.ok) {
            throw new Error('Failed to assign role');
          }
        } catch (err) {
          alert('Failed to assign role: ' + err.message);
          console.error(err);
        }
      });
    });

    document.querySelectorAll('.rbac-perm-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const pill = checkbox.closest('.rbac-pill');
        if (!pill) return;
        pill.classList.toggle('btn-primary', checkbox.checked);
        pill.classList.toggle('btn-outline', !checkbox.checked);
      });
    });

    document.querySelectorAll('.rbac-save-perms').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const role = btn.getAttribute('data-role');
        const checks = document.querySelectorAll(`.rbac-perm-checkbox[data-role="${role}"]`);
        const selected = Array.from(checks)
          .filter(c => c.checked)
          .map(c => c.getAttribute('data-perm'));
        try {
          const res = await this.authFetch(`/api/v1/rbac/roles/${encodeURIComponent(role)}/permissions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permissions: selected }),
          });
          if (!res.ok) throw new Error('Failed to update permissions');
          this.fetchRbacData(); // refresh silently
          Utils.showToast(`Permissions updated for ${role}`, 'success');
        } catch (err) {
          alert('Failed to update permissions: ' + err.message);
          console.error(err);
        }
      });
    });
  }
}.prototype));
