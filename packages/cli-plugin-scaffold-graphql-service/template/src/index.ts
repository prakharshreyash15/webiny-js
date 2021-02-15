import mdbid from "mdbid";
import { GraphQLSchemaPlugin } from "@webiny/handler-graphql/types";
import { ListResponse, Response, ErrorResponse } from "@webiny/handler-graphql";
import {
    ApplicationContext,
    CreateTargetArgs,
    DeleteTargetArgs,
    Target,
    GetTargetArgs,
    ListTargetsArgs,
    ListResolverResponse,
    ResolverResponse,
    UpdateTargetArgs
} from "./types";
import { configuration } from "./configuration";

const encodeElasticsearchCursor = (cursor?: any) => {
    if (!cursor) {
        return null;
    }

    return Buffer.from(JSON.stringify(cursor)).toString("base64");
};

const decodeElasticsearchCursor = (cursor?: string) => {
    if (!cursor) {
        return null;
    }

    return JSON.parse(Buffer.from(cursor, "base64").toString("ascii"));
};

const dateTypeFields = ["createdOn", "savedOn"];
const buildElasticsearchSort = (sort?: string[]) => {
    if (!sort || sort.length === 0) {
        return [
            {
                createdOn: {
                    order: "DESC",
                    // eslint-disable-next-line
                    unmapped_type: "date"
                }
            }
        ];
    }
    return sort.map(s => {
        const [field = "createdOn", order] = s.split("_");
        return {
            [field]: {
                order: order === "ASC" ? "ASC" : "DESC",
                // eslint-disable-next-line
                unmapped_type: dateTypeFields.includes(field)
            }
        };
    });
};
const buildElasticsearchQuery = (where?: ListTargetsArgs) => {
    if (!where) {
        return {};
    }
    return {};
};

const emptyResolver = () => ({});

export default (): GraphQLSchemaPlugin<ApplicationContext> => ({
    type: "graphql-schema",
    name: "graphql-schema-target",
    schema: {
        typeDefs: /* GraphQL */ `
            type TargetDeleteResponse {
                data: Boolean
                error: TargetError
            }

            type TargetListMeta {
                cursor: String
                hasMoreItems: Boolean!
                totalCount: Int!
            }

            type TargetError {
                code: String!
                message: String!
                data: JSON
            }

            type CreatedByResponse {
                id: String!
                displayName: String!
                type: String!
            }

            type Target {
                id: ID!
                createdOn: DateTime!
                savedOn: DateTime!
                createdBy: CreatedByResponse!
                title: String!
                description: String
                isNice: Boolean!
            }

            input TargetCreateInput {
                title: String!
                description: String
                isNice: Boolean
            }

            input TargetUpdateInput {
                title: String
                description: String
                isNice: Boolean
            }

            input TargetListWhereInput {
                title: String
                description: String
                isNice: Boolean
            }

            enum TargetListSortEnum {
                title_ASC
                title_DESC
                createdOn_ASC
                createdOn_DESC
                savedOn_ASC
                savedOn_DESC
            }

            type TargetResponse {
                data: Target
                error: TargetError
            }

            type TargetListResponse {
                data: [Target]
                meta: TargetListMeta
                error: TargetError
            }

            type TargetQuery {
                getTarget(id: ID!): TargetResponse!

                listTargets(
                    where: TargetListWhereInput
                    sort: [TargetListSortEnum!]
                    limit: Int
                    after: String
                ): TargetListResponse!
            }

            type TargetMutation {
                createTarget(data: TargetCreateInput!): TargetResponse!

                updateTarget(id: ID!, data: TargetUpdateInput!): TargetResponse!

                deleteTarget(id: ID!): TargetDeleteResponse!
            }

            extend type Query {
                targets: TargetQuery
            }

            extend type Mutation {
                targets: TargetMutation
            }
        `,
        resolvers: {
            Query: {
                targets: emptyResolver
            },
            Mutation: {
                targets: emptyResolver
            },
            TargetQuery: {
                // @ts-ignore
                getTarget: async (
                    parent,
                    args: GetTargetArgs,
                    context
                ): Promise<ResolverResponse<Target>> => {
                    const { db } = context;
                    const { id } = args;

                    // retrieve from the database
                    const response = await db.read<Target>({
                        ...configuration.db(context),
                        query: {
                            PK: id
                        },
                        limit: 1
                    });
                    const [items] = response;
                    const [item] = items;
                    if (!item) {
                        return new ErrorResponse({
                            message: `Target with id "${id}" not found.`,
                            code: "NOT_FOUND",
                            data: {
                                id
                            }
                        });
                    }

                    return new Response(item);
                },
                // @ts-ignore
                listTargets: async (
                    parent,
                    args: ListTargetsArgs,
                    context
                ): Promise<ListResolverResponse<Target>> => {
                    const { elasticSearch } = context;
                    const { where, sort, limit, after } = args;

                    const size = !limit || limit <= 0 || limit >= 1000 ? 50 : limit;

                    const body = {
                        query: buildElasticsearchQuery(where),
                        sort: buildElasticsearchSort(sort),
                        // we always take one extra to see if there are more items to be fetched
                        size: size + 1,
                        // eslint-disable-next-line
                        search_after: decodeElasticsearchCursor(after) || undefined
                    };

                    const response = await elasticSearch.search({
                        ...configuration.es(context),
                        body
                    });
                    const { hits, total } = response.body.hits;

                    const items = hits.map((item: any) => item._source);

                    const hasMoreItems = items.length > size;
                    if (hasMoreItems) {
                        // Remove the last item from results, we don't want to include it.
                        items.pop();
                    }

                    const meta = {
                        hasMoreItems,
                        totalCount: total.value,
                        cursor:
                            items.length > 0
                                ? encodeElasticsearchCursor(hits[items.length - 1].sort)
                                : null
                    };

                    return new ListResponse(items, meta);
                }
            },
            TargetMutation: {
                // @ts-ignore
                createTarget: async (
                    parent,
                    args: CreateTargetArgs,
                    context
                ): Promise<ResolverResponse<Target>> => {
                    const { db, elasticSearch, security } = context;
                    const { data } = args;

                    const date = new Date().toISOString();

                    const model: Target = {
                        id: mdbid(),
                        createdBy: security.getIdentity(),
                        savedBy: security.getIdentity(),
                        createdOn: date,
                        savedOn: date,
                        // custom user defined fields
                        title: data.title,
                        description: data.description,
                        isNice: data.isNice === undefined ? false : data.isNice
                    };
                    // save the data into the database
                    await db.create({
                        ...configuration.db(context),
                        data: {
                            PK: model.id,
                            ...model
                        }
                    });
                    // save the data into elasticsearch
                    await elasticSearch.create({
                        ...configuration.es(context),
                        id: model.id,
                        body: model
                    });

                    return new Response(data);
                },
                // @ts-ignore
                updateTarget: async (
                    parent,
                    args: UpdateTargetArgs,
                    context
                ): Promise<ResolverResponse<Target>> => {
                    const { db, elasticSearch } = context;
                    const { id, data } = args;

                    const [[item]] = await db.read<Target>({
                        ...configuration.db(context),
                        query: {
                            PK: id
                        },
                        limit: 1
                    });
                    if (!item) {
                        return new ErrorResponse({
                            message: `Target with id "${id}" not found.`,
                            code: "NOT_FOUND",
                            data: {
                                id
                            }
                        });
                    }
                    if (Object.keys(data).length === 0) {
                        return new Response(item);
                    }

                    const model: Partial<Target> = {
                        ...data,
                        savedOn: new Date().toISOString()
                    };
                    // save the data into the database
                    await db.update({
                        ...configuration.db(context),
                        query: {
                            PK: id
                        },
                        data: model
                    });
                    // save the data into elasticsearch
                    await elasticSearch.update({
                        ...configuration.es(context),
                        id: id,
                        body: {
                            doc: model
                        }
                    });

                    return new Response({
                        ...item,
                        ...model
                    });
                },
                // @ts-ignore
                deleteTarget: async (
                    parent,
                    args: DeleteTargetArgs,
                    context
                ): Promise<ResolverResponse<boolean>> => {
                    const { db, elasticSearch } = context;
                    const { id } = args;

                    const [[item]] = await db.read<Target>({
                        ...configuration.db(context),
                        query: {
                            PK: id
                        },
                        limit: 1
                    });
                    if (!item) {
                        return new ErrorResponse({
                            message: `Target with id "${id}" not found.`,
                            code: "NOT_FOUND",
                            data: {
                                id
                            }
                        });
                    }
                    // delete the data from the database
                    await db.delete({
                        ...configuration.db(context),
                        query: {
                            PK: id
                        }
                    });
                    // delete the data from elasticsearch
                    await elasticSearch.deleteByQuery({
                        ...configuration.es(context),
                        body: {
                            query: {
                                bool: {
                                    must: {
                                        term: {
                                            id
                                        }
                                    }
                                }
                            }
                        }
                    });

                    return new Response(true);
                }
            }
        }
    }
});
