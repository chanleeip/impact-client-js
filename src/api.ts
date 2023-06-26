import Axios, { AxiosError, AxiosInstance } from 'axios'
import ApiError, {
    JhTokenError,
    MissingAccessTokenCookie,
    MissingJupyterHubToken,
    ServerNotStarted,
    UnknownApiError,
} from './api-error'
import { Cookie, CookieJar } from 'tough-cookie'
import Experiment from './experiment'
import ExperimentDefinition from './experiment-definition'
import {
    Case,
    CaseId,
    CaseTrajectories,
    CustomFunction,
    ExecutionStatusType,
    ExperimentId,
    ExperimentTrajectories,
    WorkspaceDefinition,
    WorkspaceId,
    ProjectId
} from './types'
import { get } from 'http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importModule(moduleName: string): Promise<any> {
    return await import(moduleName)
}

interface AxiosConfig {
    headers: Record<string, string>
    jar?: CookieJar
}

const isNode = () => typeof window === 'undefined' //true if window is undefined(only in node.js)else false(only in browser)

const getCookieValue = (key: string) => {
    const parts = `; ${document.cookie}`.split(`; ${key}=`)

    return parts.length === 2 ? parts.pop()?.split(';').shift() : undefined
}

const getValueFromJarCookies = (key: string, cookies: Cookie[]): string => {
    const cookie = cookies.find((c) => c.key === key)

    if (!cookie) {
        throw new ApiError({
            errorCode: MissingAccessTokenCookie,
            message: 'Access token cookie not found',
        })
    }
    return cookie.value
}

const toApiError = (e: AxiosError | Error) => {
    if (e instanceof AxiosError) {
        return new ApiError({
            errorCode: e.response?.data?.error?.code || UnknownApiError,
            httpCode: e.response?.status,
            message: e.response?.data?.error?.message || 'Api Error',
        })
    }
    return e
}

class Api {
    private axios!: AxiosInstance // cannnot be null    --- used for calling axios methods
    private axiosConfig!: AxiosConfig // cannnot be null --- used for configuring axios instance like adding headers, cookies etc
    private baseUrl: string// server address
    private impactApiKey?: string// can be null  ---api key
    private impactToken?: string// can be null         --- impact token
    private jhToken: string    //                      --- jupyter hub token
    private jhUserPath: string | undefined                // jupyter hub user path

    private configureAxios() {
        const headers: Record<string, string> = {
            Authorization: `token ${this.jhToken}`,
        }
        if (this.impactToken) {
            headers['Impact-Authorization'] = `Bearer ${this.impactToken}`
        }
        this.axiosConfig = { headers }
        this.axios = Axios.create(this.axiosConfig)
    }
//configure Axios => declares headers object with Authorization and  Impact-Authorization keys (if impactToken is not null) which is then used to create axios instance
    private constructor({//destructuring object
        impactApiKey,
        impactToken,
        jupyterHubToken,
        serverAddress,
        jupyterHubUserPath,
}:{
        impactApiKey?: string
        impactToken?: string
        jupyterHubToken: string
        serverAddress: string
        jupyterHubUserPath?: string
    }) {
        this.baseUrl = serverAddress
        this.impactApiKey = impactApiKey
        this.impactToken = impactToken

        if (!jupyterHubToken) {
            throw new ApiError({
                errorCode: MissingJupyterHubToken,
                message:
                    'Impact client instantiation failed: The jupyterHubToken parameter is mandatory',
            })
        }

        if (jupyterHubUserPath) {
            this.jhUserPath =
                jupyterHubUserPath +
                (jupyterHubUserPath.endsWith('/') ? '' : '/')
        }

        this.jhToken = jupyterHubToken
        this.configureAxios()
    }

    static fromImpactApiKey({
        impactApiKey,
        jupyterHubToken,
        jupyterHubUserPath,
        serverAddress,
    }: {
        impactApiKey: string
        jupyterHubToken: string
        jupyterHubUserPath?: string
        serverAddress: string
    }) {
        return new Api({
            impactApiKey,
            jupyterHubToken,
            jupyterHubUserPath,
            serverAddress,
        })
    }

    static fromImpactToken({
        impactToken,
        jupyterHubToken,
        jupyterHubUserPath,
        serverAddress,
    }: {
        impactToken: string
        jupyterHubToken: string
        jupyterHubUserPath?: string
        serverAddress: string
    }) {
        return new Api({
            impactToken,
            jupyterHubToken,
            jupyterHubUserPath,
            serverAddress,
        })
    }

    private isConfiguredForNode = () => !!this.axiosConfig.jar//returns true if jar is not null else false

    private isConfiguredForImpact = () =>
        !!this.axiosConfig.headers['Impact-Authorization']//returns true if Impact-Authorization is not null else false

    private getNodeCookieJar = () => this.axiosConfig.jar

    private ensureAxiosConfig = async () => {
        if (isNode()) {
            if (
                !this.isConfiguredForNode() ||//returns true if jar is null
                (this.impactToken && !this.isConfiguredForImpact())//returns true if Impact-Authorization is null 
            ) {
                const AxiosCookieSupport = await importModule(
                    'axios-cookiejar-support'
                )//
                const ToughCookie = await importModule('tough-cookie')

                const jar = new ToughCookie.CookieJar(
                    new ToughCookie.MemoryCookieStore(),
                    {
                        allowSpecialUseDomain: true,
                        rejectPublicSuffixes: false,
                    }
                )
                const headers: Record<string, string> = {
                    Authorization: `token ${this.jhToken}`,
                }
                if (this.impactToken) {
                    headers[
                        'Impact-Authorization'
                    ] = `Bearer ${this.impactToken}`
                }

                this.axiosConfig = { headers, jar }

                this.axios = AxiosCookieSupport.wrapper(
                    Axios.create(this.axiosConfig)
                )
            }
        } else {
            if (this.impactToken && !this.isConfiguredForImpact()) {//returns true if Impact-Authorization is null
                const headers: Record<string, string> = {
                    Authorization: `token ${this.jhToken}`,
                    'Impact-Authorization': `Bearer ${this.impactToken}`,
                }
                this.axiosConfig = { headers }
                this.axios = Axios.create(this.axiosConfig)
            }
        }
    }

    private ensureJhUserPath = async () => {
        if (this.jhUserPath) {
            return
        }
        try {
            const response = await this.axios.get(
                `${this.baseUrl}/hub/api/authorizations/token/${this.jhToken}`
            )
            const { server } = response.data
            if (!server) {
                throw new ApiError({
                    errorCode: ServerNotStarted,
                    message:
                        'Server not started on JH or missing JH token scope.',
                })
            }
            this.jhUserPath = server
        } catch (e) {
            if (e instanceof AxiosError) {
                throw new ApiError({
                    errorCode: JhTokenError,
                    httpCode: e.response?.status,
                    message:
                        'Failed to authorize with JupyterHub, invalid token?',
                })
            }
            throw e
        }
    }

    private ensureImpactToken = async () => {
        await this.ensureAxiosConfig()
        await this.ensureJhUserPath()

        if (this.impactToken) {
            return
        }

        await this.axios.post(
            `${this.baseUrl}${this.jhUserPath}impact/api/login`,
            { secretKey: this.impactApiKey }
        )
        // extract cookie value, set cookie
        const nodeCookieJar = this.getNodeCookieJar()
        if (nodeCookieJar) {
            // Get cookie value from cookiejar
            const cookies = await nodeCookieJar.getCookies(
                `${this.baseUrl}${this.jhUserPath}`
            )
            this.impactToken = getValueFromJarCookies('access_token', cookies)
        } else {
            this.impactToken = getCookieValue('access_token')
        }
        // Update axios config with the acquired impactToken
        await this.ensureAxiosConfig()
    }

    getWorkspaces = async (): Promise<WorkspaceDefinition[]> => {
        return new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .get(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces`
                        )
                        .then((response) => resolve(response.data?.data?.items))
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })
    }
    getWorkSpacesID = async ({
        workspaceId,
    }: {
        workspaceId: WorkspaceId
    }): Promise<ExperimentDefinition[]> => {
        return new Promise((resolve, reject) => {
            this.ensureImpactToken()
            .then(() => {
                this.axios
                    .get(
                        `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}`
                    )
                    .then((response) => resolve(response.data?.definition))
                    .catch((e) => reject(toApiError(e)))
            })
            .catch((e) => reject(toApiError(e)))
    })
    }
    getWorkspaceProjects= async ({
        workspaceId,
    }: {
        workspaceId: WorkspaceId
    }): Promise<ExperimentDefinition[]> => {
        return new Promise((resolve, reject) => {
            this.ensureImpactToken()
            .then(() => {
                this.axios
                    .get(
                        `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/projects`
                    )
                    .then((response) => resolve(response.data))
                    .catch((e) => reject(toApiError(e)))
            })
            .catch((e) => reject(toApiError(e)))
    })
    }
    getWorkspaceProjectExperiments= async ({
        workspaceId,
        projectId,
    }: {
        workspaceId: WorkspaceId,
        projectId: ProjectId
    }): Promise<ExperimentDefinition[]> => {
        return new Promise((resolve, reject) => {
            this.ensureImpactToken()
            .then(() => {
                this.axios
                    .get(
                        `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/projects/${projectId}/experiments`
                    )
                    .then((response) => resolve(response.data))
                    .catch((e) => reject(toApiError(e)))
            })
            .catch((e) => reject(toApiError(e)))
    })
    }
    getExperimentsMetaData = async ({
        workspaceId,
    }: {
        workspaceId: WorkspaceId
    }): Promise<ExperimentDefinition[]> => {
        return new Promise((resolve, reject) => {
            this.ensureImpactToken()
            .then(() => {
                this.axios
                    .get(
                        `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments`
                    )
                    .then((response) => resolve(response.data))
                    .catch((e) => reject(toApiError(e)))
            })
            .catch((e) => reject(toApiError(e)))
    })
}
getVariables = async ({
    workspaceId,
    experimentId,
}: {
    workspaceId: WorkspaceId,
    experimentId: ExperimentId
}): Promise<ExperimentDefinition[]> => {
    return new Promise((resolve, reject) => {
        this.ensureImpactToken()
        .then(() => {
            this.axios
                .get(   
                    `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/variables`
                )
                .then((response) => resolve(response.data))
                .catch((e) => reject(toApiError(e)))
        })
        .catch((e) => reject(toApiError(e)))
})
}

    createExperiment = async ({
        experimentDefinition,
        workspaceId,
    }: {
        experimentDefinition: ExperimentDefinition
        workspaceId: WorkspaceId
    }): Promise<ExperimentId> => {
        return new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .post(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments`,
                            {
                                experiment:
                                    experimentDefinition.toModelicaExperimentDefinition(),
                            }
                        )
                        .then((response) =>
                            resolve(response.data.experiment_id)
                        )
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })
    }

    cancelExperiment = async ({
        experimentId,
        workspaceId,
    }: {
        experimentId: ExperimentId
        workspaceId: WorkspaceId
    }): Promise<void> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .delete(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/execution`
                        )
                        .then(() => resolve())
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    createWorkspace = async ({
        description,
        name,
    }: {
        description?: string
        name: string
    }): Promise<WorkspaceId> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .post(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces`,
                            {
                                new: {
                                    description,
                                    name,
                                },
                            }
                        )
                        .then((response) => resolve(response.data.id))
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    deleteWorkspace = async (workspaceId: WorkspaceId): Promise<void> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .delete(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}`
                        )
                        .then(() => resolve())
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    runExperiment = async ({
        cases,
        experimentId,
        workspaceId,
    }: {
        cases: CaseId[]
        experimentId: ExperimentId
        workspaceId: WorkspaceId
    }): Promise<void> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .post(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/execution`,
                            {
                                includeCases: {
                                    ids: cases,
                                },
                                options: {
                                    forceCompilation: true,
                                },
                            }
                        )
                        .then(() => resolve())
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    getExecutionStatus = async ({
        experimentId,
        workspaceId,
    }: {
        experimentId: ExperimentId
        workspaceId: WorkspaceId
    }): Promise<ExecutionStatusType> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .get(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/execution`
                        )
                        .then((response) => resolve(response.data))
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    getCustomFunctions = (
        workspaceId: WorkspaceId
    ): Promise<CustomFunction[]> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .get(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/custom-functions`
                        )
                        .then((response) => resolve(response.data.data.items))
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    getExperiment = ({
        experimentId,
        workspaceId,
    }: {
        experimentId: ExperimentId
        workspaceId: WorkspaceId
    }): Promise<Experiment | undefined> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .get(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}`,
                            {
                                headers: {
                                    Accept: 'application/vnd.impact.experiment.v2+json',
                                },
                            }
                        )
                        .then(() =>
                            resolve(
                                new Experiment({
                                    api: this,
                                    id: experimentId,
                                    workspaceId,
                                })
                            )
                        )
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    getCases = ({
        experimentId,
        workspaceId,
    }: {
        experimentId: ExperimentId
        workspaceId: WorkspaceId
    }): Promise<Case[] | undefined> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .get(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/cases`
                        )
                        .then((response) => resolve(response.data?.data?.items))
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    getExperimentTrajectories = ({
        experimentId,
        variableNames,
        workspaceId,
    }: {
        experimentId: ExperimentId
        variableNames: string[]
        workspaceId: WorkspaceId
    }): Promise<ExperimentTrajectories> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .post(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/trajectories`,
                            { variable_names: variableNames },
                            {
                                headers: {
                                    Accept: 'application/vnd.impact.trajectories.v2+json',
                                },
                            }
                        )
                        .then((res) => resolve(res.data.data.items))
                })
                .catch((e) => reject(toApiError(e)))
        })

    getCaseLog = ({
        caseId,
        experimentId,
        workspaceId,
    }: {
        caseId: CaseId
        experimentId: ExperimentId
        workspaceId: WorkspaceId
    }): Promise<string> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .get(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/cases/${caseId}/log`
                        )
                        .then((res) => resolve(res.data))
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    getCaseTrajectories = ({
        caseId,
        experimentId,
        variableNames,
        workspaceId,
    }: {
        caseId: CaseId
        experimentId: ExperimentId
        variableNames: string[]
        workspaceId: WorkspaceId
    }): Promise<CaseTrajectories> =>
        new Promise((resolve, reject) => {
            this.ensureImpactToken()
                .then(() => {
                    this.axios
                        .post(
                            `${this.baseUrl}${this.jhUserPath}impact/api/workspaces/${workspaceId}/experiments/${experimentId}/cases/${caseId}/trajectories`,
                            { variable_names: variableNames },
                            {
                                headers: {
                                    Accept: 'application/vnd.impact.trajectories.v2+json',
                                },
                            }
                        )
                        .then((res) => resolve(res.data.data.items))
                        .catch((e) => reject(toApiError(e)))
                })
                .catch((e) => reject(toApiError(e)))
        })

    setImpactToken = (token: string) => {
        this.impactToken = token
        this.configureAxios()
    }
}

export default Api
