/** Internal contract shared by the two modules in this package. */
import type MachineManagement from './index.mjs';
export type MachineId = string;
export type MachineManagementService = InstanceType<typeof MachineManagement>;
export interface MachineDetailProps {
  machineId: MachineId;
  openKey: string | number;
  refreshKey: string | number;
}
declare module '@deepseek-ai/cordis' {
  interface Context { machineMgmt: MachineManagementService }
}
