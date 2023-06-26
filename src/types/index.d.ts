import { components, operations } from '../schema/impact-api'

export type Case = components['schemas']['Case']

export type CustomFunction =
    operations['getCustomFunction']['responses']['200']['content']['application/json']

export type ExecutionStatusType =
    operations['getExecutionStatus']['responses']['200']['content']['application/json']

export type WorkspaceDefinition = components['schemas']['Workspace']

export type ModelicaExperimentDefinition =
    components['schemas']['ExperimentDefinition']

export type ModelicaExperimentExtensions = components['schemas']['Extensions']

export type ModelicaExperimentParameters =
    components['schemas']['Analysis']['parameters']

export type ModelicaExperimentModifiers = components['schemas']['Modifiers']

export type CaseTrajectories =
    operations['getTrajectories']['responses']['200']['content']['application/vnd.impact.trajectories.v2+json']['data']['items']

export type CaseRunInfo =
    operations['getAllCaseInfo']['responses']['200']['content']['application/json']['data']['items'][0]['run_info']

export type ExperimentTrajectories =
    operations['getTrajectories']['responses']['200']['content']['application/vnd.impact.trajectories.v2+json']['data']['items']

export type CaseId = string
export type ExperimentId = string
export type WorkspaceId = string
export type ProjectId  = string
