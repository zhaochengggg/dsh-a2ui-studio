import machine,{TYPERT as machineTypes} from './machines/remote.mjs';
import apps,{TYPERT as appTypes} from './apps/src/remote.ts';
export const TYPERT={package:'dsh-machine-apps',face:'host',schemas:[],invocations:[...machineTypes.invocations,...appTypes.invocations],model:{services:[...machineTypes.model.services,...appTypes.model.services],events:[],objects:[]}};
export default {package:'dsh-machine-apps',descriptors:[...machine.descriptors,...apps.descriptors]};
