import type { Route } from "../router.js";
import { BackupDetail, Backups } from "./Backups.js";
import { Dashboard } from "./Dashboard.js";
import { Doctor } from "./Doctor.js";
import { EnvironmentEdit } from "./EnvironmentEdit.js";
import { Environments } from "./Environments.js";
import { JobLive, Jobs } from "./Jobs.js";
import { NewBackup } from "./NewBackup.js";
import { Onboarding } from "./Onboarding.js";
import { Prune } from "./Prune.js";
import { Service } from "./Service.js";
import { Settings } from "./Settings.js";

export function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "onboarding":
      return <Onboarding />;
    case "dashboard":
      return <Dashboard />;
    case "environments":
      return <Environments />;
    case "environment-edit":
      return (
        <EnvironmentEdit
          key={route.env ?? "new"}
          envName={route.env}
          onboarding={route.onboarding}
        />
      );
    case "backups":
      return <Backups key={route.env ?? "all"} envName={route.env} />;
    case "backup-detail":
      return <BackupDetail envName={route.env} id={route.id} />;
    case "jobs":
      return <Jobs />;
    case "job-live":
      return <JobLive key={route.id} id={route.id} />;
    case "new-backup":
      return <NewBackup envName={route.env} />;
    case "prune":
      return <Prune />;
    case "service":
      return <Service />;
    case "doctor":
      return <Doctor />;
    case "settings":
      return <Settings />;
  }
}
