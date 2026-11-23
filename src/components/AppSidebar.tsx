import { SolunaLogo } from "./SolunaLogo";
import { navigation, secondaryNavigation } from "../app/navigation";
import type { NavKey } from "../types";

interface AppSidebarProps {
  collapsed: boolean;
  active: NavKey;
  authenticated: boolean;
  onToggleCollapsed: () => void;
  onNavigate: (next: NavKey) => void;
}

export function AppSidebar({ collapsed, active, authenticated, onToggleCollapsed, onNavigate }: AppSidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" title="Soluna">
          <SolunaLogo size={collapsed ? 38 : 44} />
        </div>
        {!collapsed && (
          <div>
            <strong>Soluna</strong>
            <span>Desktop</span>
          </div>
        )}
        <button
          className="sidebar-toggle"
          onClick={() => onToggleCollapsed()}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      <nav className="primary-nav" aria-label="Main navigation">
        {navigation.map((item) => (
          <button
            key={item.key}
            className={active === item.key ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate(item.key)}
            title={collapsed ? item.label : undefined}
            aria-current={active === item.key ? "page" : undefined}
          >
            <span className="nav-icon">{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>
      <nav className="secondary-nav" aria-label="Secondary navigation">
        {secondaryNavigation.map((item) => (
          <button
            key={item.key}
            className={active === item.key ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate(item.key)}
            title={collapsed ? item.label : undefined}
            aria-current={active === item.key ? "page" : undefined}
          >
            <span className="nav-icon">{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>
      {!collapsed && (
        <div className="sidebar-footer">
          <span className="guest-label">
            {authenticated ? "YouTube Music account connected" : "Guest mode · account optional"}
          </span>
        </div>
      )}
    </aside>
  );
}
