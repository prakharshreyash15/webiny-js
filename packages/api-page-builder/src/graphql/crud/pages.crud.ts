import { ContextPlugin } from "@webiny/handler/types";
import mdbid from "mdbid";
import defaults from "./utils/defaults";
import uniqid from "uniqid";
import { NotAuthorizedError } from "@webiny/api-security";
import Error from "@webiny/error";
import { NotFoundError } from "@webiny/handler-graphql";
import getNormalizedListPagesArgs from "./utils/getNormalizedListPagesArgs";
import trimStart from "lodash/trimStart";
import omit from "lodash/omit";
import merge from "lodash/merge";
import getPKPrefix from "./utils/getPKPrefix";
import DataLoader from "dataloader";

import {
    PageHookPlugin,
    PbContext,
    Page,
    PageSecurityPermission
} from "@webiny/api-page-builder/types";
import createListMeta from "./utils/createListMeta";
import checkBasePermissions from "./utils/checkBasePermissions";
import checkOwnPermissions from "./utils/checkOwnPermissions";
import executeHookCallbacks from "./utils/executeHookCallbacks";
import path from "path";
import normalizePath from "./pages/normalizePath";
import { compressContent, extractContent } from "./pages/contentCompression";
import { CreateDataModel, UpdateSettingsModel, UpdateDataModel } from "./pages/models";
import { getESLatestPageData, getESPublishedPageData } from "./pages/esPageData";

import { Args as FlushArgs } from "@webiny/api-prerendering-service/flush/types";

import { TYPE } from "@webiny/api-page-builder/types";

const STATUS_CHANGES_REQUESTED = "changesRequested";
const STATUS_REVIEW_REQUESTED = "reviewRequested";
const STATUS_DRAFT = "draft";
const STATUS_PUBLISHED = "published";
const STATUS_UNPUBLISHED = "unpublished";

const getZeroPaddedVersionNumber = number => String(number).padStart(4, "0");

const DEFAULT_EDITOR = "page-builder";
const PERMISSION_NAME = "pb.page";

const plugin: ContextPlugin<PbContext> = {
    type: "context",
    async apply(context) {
        const { db, i18nContent, elasticSearch } = context;

        const PK_PAGE = pid => `${getPKPrefix(context)}P#${pid}`;
        const PK_PAGE_PUBLISHED_PATH = () => `${getPKPrefix(context)}PATH`;
        const ES_DEFAULTS = () => defaults.es(context);

        // Used in a couple of key events - (un)publishing and pages deletion.
        const hookPlugins = context.plugins.byType<PageHookPlugin>("pb-page-hook");

        context.pageBuilder = {
            ...context.pageBuilder,
            pages: {
                dataLoaders: {
                    getPublishedById: new DataLoader(
                        async argsArray => {
                            const batch = db.batch();
                            const notFoundError = new NotFoundError("Page not found.");
                            const idNotProvidedError = new Error(
                                'Cannot get published page - "id" not provided.'
                            );

                            const errorsAndResults = [];

                            let batchResultIndex = 0;
                            for (let i = 0; i < argsArray.length; i++) {
                                const args = argsArray[i];

                                if (!args.id) {
                                    errorsAndResults.push(idNotProvidedError);
                                    continue;
                                }

                                // If we have a full ID, then try to load it directly.
                                const [pid, version] = args.id.split("#");

                                if (version) {
                                    errorsAndResults.push(batchResultIndex++);
                                    batch.read({
                                        ...defaults.db,
                                        query: { PK: PK_PAGE(pid), SK: `REV#${version}` }
                                    });
                                    continue;
                                }

                                errorsAndResults.push(batchResultIndex++);
                                batch.read({
                                    ...defaults.db,
                                    query: {
                                        PK: PK_PAGE(pid),
                                        SK: `P`
                                    }
                                });
                            }

                            // Replace batch result indexes with actual results.
                            const batchResults = await batch.execute();
                            for (let i = 0; i < errorsAndResults.length; i++) {
                                const errorResult = errorsAndResults[i];
                                if (typeof errorResult !== "number") {
                                    continue;
                                }

                                const [[page]] = batchResults[errorResult];
                                if (!page) {
                                    errorsAndResults[i] = notFoundError;
                                    continue;
                                }

                                // If preview enabled, return the page, without checking if the page
                                // is published. The preview flag is not utilized anywhere else.
                                if (argsArray[i].preview || page.status === "published") {
                                    errorsAndResults[i] = page;

                                    // Extract compressed page content.
                                    errorsAndResults[i].content = await extractContent(
                                        errorsAndResults[i].content
                                    );

                                    continue;
                                }

                                errorsAndResults[i] = notFoundError;
                            }

                            return errorsAndResults;
                        },
                        {
                            cacheKeyFn: key => key.id + key.preview
                        }
                    )
                },
                async get(id) {
                    const [pid, rev] = id.split("#");
                    const permission = await checkBasePermissions(context, PERMISSION_NAME, {
                        rwd: "r"
                    });

                    let page;
                    if (rev) {
                        const [[exactRevision]] = await db.read<Page>({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `REV#${rev}` }
                        });
                        page = exactRevision;
                    } else {
                        const [[latestRevision]] = await db.read<Page>({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `L` }
                        });
                        page = latestRevision;
                    }

                    if (!page) {
                        throw new NotFoundError("Page not found.");
                    }

                    const identity = context.security.getIdentity();
                    checkOwnPermissions(identity, permission, page, "ownedBy");

                    // Extract compressed page content.
                    page.content = await extractContent(page.content);
                    return page;
                },

                async getPublishedById(args) {
                    return this.dataLoaders.getPublishedById.load(args);
                },

                async getPublishedByPath(args) {
                    if (!args.path) {
                        throw new Error('Cannot get published page - "path" not provided.');
                    }

                    const notFoundError = new NotFoundError("Page not found.");

                    const normalizedPath = normalizePath(args.path);
                    if (normalizedPath === "/") {
                        const settings = await context.pageBuilder.settings.default.get();
                        if (!settings?.pages?.home) {
                            throw notFoundError;
                        }

                        return context.pageBuilder.pages.getPublishedById({
                            id: settings.pages.home
                        });
                    }

                    const [[page]] = await db.read<Page>({
                        ...defaults.db,
                        query: { PK: PK_PAGE_PUBLISHED_PATH(), SK: normalizedPath }
                    });

                    if (!page) {
                        throw notFoundError;
                    }

                    if (page) {
                        // Extract compressed page content.
                        page.content = await extractContent(page.content);
                        return page;
                    }

                    throw notFoundError;
                },

                async listLatest(args) {
                    const permission = await checkBasePermissions(context, PERMISSION_NAME, {
                        rwd: "r"
                    });
                    const { sort, from, size, query, page } = getNormalizedListPagesArgs(args);

                    query.bool.filter.push(
                        {
                            term: { "locale.keyword": i18nContent.getLocale().code }
                        },
                        { term: { latest: true } }
                    );

                    // If users can only manage own records, let's add the special filter.
                    if (permission.own === true) {
                        const identity = context.security.getIdentity();
                        query.bool.filter.push({
                            term: { "createdBy.id.keyword": identity.id }
                        });
                    }

                    const response = await elasticSearch.search({
                        ...ES_DEFAULTS(),
                        body: {
                            query,
                            from,
                            size,
                            sort
                        }
                    });

                    const results = response.body.hits;
                    const total = results.total.value;
                    const data = total > 0 ? results.hits.map(item => item._source) : [];

                    const meta = createListMeta({ page, limit: size, totalCount: total });
                    return [data, meta];
                },

                async listPublished(args) {
                    const { sort, from, size, query, page } = getNormalizedListPagesArgs(args);

                    query.bool.filter.push(
                        {
                            term: { "locale.keyword": i18nContent.getLocale().code }
                        },
                        { term: { published: true } }
                    );

                    const response = await elasticSearch.search({
                        ...ES_DEFAULTS(),
                        body: {
                            query,
                            from,
                            size,
                            sort
                        }
                    });

                    const results = response.body.hits;
                    const total = results.total.value;
                    const data = total > 0 ? results.hits.map(item => item._source) : [];

                    const meta = createListMeta({ page, limit: size, totalCount: total });
                    return [data, meta];
                },

                async listTags(args) {
                    if (args.search.query.length < 2) {
                        throw new Error("Please provide at least two characters.");
                    }

                    const response = await elasticSearch.search({
                        ...ES_DEFAULTS(),
                        body: {
                            size: 0,
                            aggs: {
                                tags: {
                                    terms: {
                                        field: "tags.keyword",
                                        include: `.*${args.search.query}.*`,
                                        size: 10
                                    }
                                }
                            }
                        }
                    });

                    try {
                        return response.body.aggregations.tags.buckets.map(item => item.key);
                    } catch {
                        return [];
                    }
                },

                async listPageRevisions(pageId) {
                    const [pid] = pageId.split("#");
                    const [pages] = await db.read<Page>({
                        ...defaults.db,
                        query: {
                            PK: PK_PAGE(pid),
                            SK: { $beginsWith: "REV#" },
                            sort: { SK: -1 }
                        }
                    });

                    return pages.sort((a, b) => b.version - a.version);
                },

                async create(categorySlug) {
                    await checkBasePermissions(context, PERMISSION_NAME, { rwd: "w" });

                    const category = await context.pageBuilder.categories.get(categorySlug);
                    if (!category) {
                        throw new NotFoundError(`Category with slug "${categorySlug}" not found.`);
                    }

                    const title = "Untitled";

                    let pagePath = "";
                    if (category.slug === "static") {
                        pagePath = normalizePath("untitled-" + uniqid.time());
                    } else {
                        pagePath = normalizePath(
                            path.join(category.url, "untitled-" + uniqid.time())
                        );
                    }

                    const identity = context.security.getIdentity();
                    new CreateDataModel().populate({ category: category.slug }).validate();

                    const [pid, version] = [mdbid(), 1];
                    const zeroPaddedVersion = getZeroPaddedVersionNumber(version);

                    const id = `${pid}#${zeroPaddedVersion}`;

                    const updateSettingsModel = new UpdateSettingsModel().populate({
                        general: {
                            layout: category.layout
                        }
                    });

                    const owner = {
                        id: identity.id,
                        displayName: identity.displayName,
                        type: identity.type
                    };

                    const data = {
                        PK: PK_PAGE(pid),
                        SK: `REV#${zeroPaddedVersion}`,
                        TYPE: TYPE.PAGE,
                        id,
                        pid,
                        locale: context.i18nContent.getLocale().code,
                        tenant: context.security.getTenant().id,
                        editor: DEFAULT_EDITOR,
                        category: category.slug,
                        title,
                        path: pagePath,
                        version: 1,
                        status: STATUS_DRAFT,
                        visibility: {
                            list: { latest: true, published: true },
                            get: { latest: true, published: true }
                        },
                        locked: false,
                        publishedOn: null,
                        createdFrom: null,
                        settings: await updateSettingsModel.toJSON(),
                        savedOn: new Date().toISOString(),
                        createdOn: new Date().toISOString(),
                        ownedBy: owner,
                        createdBy: owner,
                        content: compressContent() // Just create the initial { compression, content } object.
                    };

                    await executeHookCallbacks(hookPlugins, "beforeCreate", context, data);

                    await db
                        .batch()
                        .create({ ...defaults.db, data })
                        .create({
                            ...defaults.db,
                            data: { ...data, PK: PK_PAGE(pid), SK: "L" }
                        })
                        .execute();

                    // Index page in "Elastic Search"
                    await elasticSearch.index({
                        ...ES_DEFAULTS(),
                        id: "L#" + pid,
                        body: getESLatestPageData(context, data)
                    });

                    await executeHookCallbacks(hookPlugins, "afterCreate", context, data);

                    return omit(data, ["PK", "SK", "content"]) as any;
                },

                async createFrom(from) {
                    const permission = await checkBasePermissions(context, PERMISSION_NAME, {
                        rwd: "w"
                    });

                    const [fromPid, fromVersion] = from.split("#");

                    const [[[page]], [[latestPage]]] = await db
                        .batch<[[Page]], [[Page]]>()
                        .read({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(fromPid),
                                SK: `REV#${fromVersion}`
                            }
                        })
                        .read({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(fromPid),
                                SK: "L"
                            }
                        })
                        .execute();

                    if (!page) {
                        throw new NotFoundError(`Page "${from}" not found.`);
                    }

                    // Must not be able to create a new page (revision) from a page of another author.
                    if (permission?.own === true) {
                        const identity = context.security.getIdentity();
                        if (page.ownedBy.id !== identity.id) {
                            throw new NotAuthorizedError();
                        }
                    }

                    const nextVersion = latestPage.version + 1;
                    const zeroPaddedNextVersion = getZeroPaddedVersionNumber(nextVersion);
                    const nextId = `${fromPid}#${zeroPaddedNextVersion}`;
                    const identity = context.security.getIdentity();

                    const data: Record<string, any> = {
                        ...page,
                        SK: `REV#${zeroPaddedNextVersion}`,
                        id: nextId,
                        status: STATUS_DRAFT,
                        locked: false,
                        publishedOn: null,
                        version: nextVersion,
                        savedOn: new Date().toISOString(),
                        createdFrom: from,
                        createdOn: new Date().toISOString(),
                        createdBy: {
                            id: identity.id,
                            displayName: identity.displayName,
                            type: identity.type
                        }
                    };

                    await executeHookCallbacks(hookPlugins, "beforeCreate", context, data);

                    await db
                        .batch()
                        .create({ ...defaults.db, data })
                        .update({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(fromPid),
                                SK: "L"
                            },
                            data: {
                                ...data,
                                PK: PK_PAGE(fromPid),
                                SK: "L"
                            }
                        })
                        .execute();

                    // If the new revision is visible in "latest" page lists, then update the ES index.
                    if (data?.visibility?.list?.latest !== false) {
                        // Replace existing `"L#" + fromParent` entry with the new one.
                        await elasticSearch.index({
                            ...ES_DEFAULTS(),
                            id: "L#" + fromPid,
                            body: getESLatestPageData(context, data)
                        });
                    }

                    await executeHookCallbacks(hookPlugins, "afterCreate", context, data);

                    // Extract compressed page content.
                    page.content = await extractContent(page.content);
                    return data as Page;
                },

                async update(id, data) {
                    const permission = await checkBasePermissions(context, PERMISSION_NAME, {
                        rwd: "w"
                    });

                    const [pid, rev] = id.split("#");

                    const [[[page]], [[latestPage]]] = await db
                        .batch()
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `REV#${rev}` },
                            limit: 1
                        })
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: "L" },
                            limit: 1
                        })
                        .execute();

                    if (!page) {
                        throw new NotFoundError(`Page "${id}" not found.`);
                    }

                    if (page.locked) {
                        throw new Error(`Cannot update page because it's locked.`);
                    }

                    const identity = context.security.getIdentity();
                    checkOwnPermissions(identity, permission, page, "ownedBy");

                    const updateDataModel = new UpdateDataModel().populate(data);
                    await updateDataModel.validate();

                    const updateData = await updateDataModel.toJSON({ onlyDirty: true });

                    const updateSettingsModel = new UpdateSettingsModel()
                        .populate(page.settings)
                        .populate(data.settings);

                    await updateSettingsModel.validate();

                    updateData.settings = await updateSettingsModel.toJSON();
                    updateData.savedOn = new Date().toISOString();

                    await executeHookCallbacks(hookPlugins, "beforeUpdate", context, page);

                    if (updateData.content) {
                        updateData.content = compressContent(updateData.content);
                    }

                    await db.update({
                        ...defaults.db,
                        query: { PK: PK_PAGE(pid), SK: `REV#${rev}` },
                        data: updateData
                    });

                    // If we updated the latest rev, make sure the changes are propagated to "L" record and ES.
                    if (latestPage.id === id) {
                        await db.update({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: "L" },
                            data: updateData
                        });

                        // Update the ES index according to the value of the "latest pages lists" visibility setting.
                        if (updateData?.visibility?.list?.latest !== false) {
                            await elasticSearch.index({
                                ...ES_DEFAULTS(),
                                id: `L#${pid}`,
                                body: getESLatestPageData(context, { ...page, ...data })
                            });
                        } else {
                            await elasticSearch.delete({
                                ...ES_DEFAULTS(),
                                id: `L#${pid}`
                            });
                        }
                    }

                    await executeHookCallbacks(hookPlugins, "afterUpdate", context, page);

                    return { ...page, ...data };
                },

                async delete(pageId) {
                    const permission = await checkBasePermissions(context, PERMISSION_NAME, {
                        rwd: "d"
                    });

                    const [pid, rev] = pageId.split("#");

                    // 1. Load the page and latest / published page (rev) data.
                    const [[[page]], [[latestPage]], [[publishedPage]]] = await db
                        .batch<[[Page]], [[Page]], [[Page]]>()
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `REV#${rev}` }
                        })
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: "L" }
                        })
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: "P" }
                        })
                        .execute();

                    // 2. Do a couple of checks.
                    if (!page) {
                        throw new NotFoundError(`Page "${pageId}" not found.`);
                    }

                    const identity = context.security.getIdentity();
                    checkOwnPermissions(identity, permission, page, "ownedBy");

                    const settings = await context.pageBuilder.settings.default.get();
                    const pages = settings?.pages || {};
                    for (const key in pages) {
                        if (pages[key] === page.pid) {
                            throw new Error(`Cannot delete page because it's set as ${key}.`);
                        }
                    }

                    // 3. Let's start updating. But first, let's trigger before-delete hook callbacks.
                    await executeHookCallbacks(hookPlugins, "beforeDelete", context, {
                        page,
                        latestPage,
                        publishedPage
                    });

                    // Before we continue, note that if `publishedPageData` exists, then `publishedPagePathData`
                    // also exists. And to delete it, we can read `publishedPageData.path` to get its SK.
                    // There can't be a situation where just one record exists, there's always gonna be both.

                    // If we are deleting the initial version, we need to remove all versions and all of the meta data.
                    if (page.version === 1) {
                        // 4.1. We delete pages in batches of 15.
                        let publishedPathEntryDeleted = false;
                        while (true) {
                            const [pageItemCollection] = await db.read({
                                ...defaults.db,
                                limit: 15,
                                query: { PK: PK_PAGE(pid), SK: { $gte: " " } }
                            });

                            if (pageItemCollection.length === 0) {
                                break;
                            }

                            const batch = db.batch();
                            for (let i = 0; i < pageItemCollection.length; i++) {
                                const item = pageItemCollection[i];
                                if (item.status === "published" && !publishedPathEntryDeleted) {
                                    publishedPathEntryDeleted = true;
                                    batch.delete({
                                        ...defaults.db,
                                        query: { PK: PK_PAGE_PUBLISHED_PATH(), SK: item.path }
                                    });
                                }

                                batch.delete({
                                    ...defaults.db,
                                    query: { PK: item.PK, SK: item.SK }
                                });
                            }

                            await batch.execute();
                        }

                        // 4.2. Finally, delete data from ES.
                        await elasticSearch.bulk({
                            body: [
                                {
                                    delete: {
                                        _id: `L#${pid}`,
                                        _index: ES_DEFAULTS().index
                                    }
                                },
                                {
                                    delete: {
                                        _id: `P#${pid}`,
                                        _index: ES_DEFAULTS().index
                                    }
                                }
                            ]
                        });

                        await executeHookCallbacks(hookPlugins, "afterDelete", context, {
                            page,
                            latestPage,
                            publishedPage
                        });

                        return [page, null];
                    }

                    // 5. If we are deleting a specific version (version > 1)...

                    // 6.1. Delete the actual page entry.
                    const batch = db.batch().delete({
                        ...defaults.db,
                        query: { PK: PK_PAGE(pid), SK: `REV#${rev}` }
                    });

                    // We need to update / delete data in ES too.
                    const esOperations = [];

                    // 6.2. If the page is published, remove published data, both from DB and ES.
                    if (publishedPage && publishedPage.id === page.id) {
                        batch
                            .delete({
                                ...defaults.db,
                                query: {
                                    PK: PK_PAGE(pid),
                                    SK: "P"
                                }
                            })
                            .delete({
                                ...defaults.db,
                                query: {
                                    PK: PK_PAGE_PUBLISHED_PATH(),
                                    SK: publishedPage.path
                                }
                            });

                        esOperations.push({
                            delete: { _id: `P#${pid}`, _index: ES_DEFAULTS().index }
                        });
                    }

                    // 6.3. If the page is latest, assign the previously latest page as the new latest.
                    // Updates must be made again both on DB and ES side.
                    let newLatestPage;
                    if (latestPage.id === page.id) {
                        [[newLatestPage]] = await db.read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: { $lt: `REV#${rev}` } },
                            sort: { SK: -1 },
                            limit: 1
                        });

                        // Update latest page data.
                        batch.update({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "L"
                            },
                            data: {
                                ...newLatestPage,
                                PK: PK_PAGE(pid),
                                SK: "L"
                            }
                        });

                        // And of course, update the latest rev entry in ES.
                        esOperations.push(
                            {
                                index: { _id: `L#${pid}`, _index: ES_DEFAULTS().index }
                            },
                            getESLatestPageData(context, newLatestPage)
                        );
                    }

                    await batch.execute();

                    // When deleting a non-published and non-latest rev, we mustn't execute the bulk operation.
                    if (esOperations.length) {
                        await elasticSearch.bulk({ body: esOperations });
                    }

                    await executeHookCallbacks(hookPlugins, "afterDelete", context, {
                        page,
                        latestPage,
                        publishedPage
                    });

                    // 7. Done. We return both the deleted page, and the new latest one (if there is one).
                    return [page, newLatestPage];
                },

                async publish(pageId: string) {
                    const permission = await checkBasePermissions<PageSecurityPermission>(
                        context,
                        PERMISSION_NAME,
                        {
                            pw: "p"
                        }
                    );

                    const [pid, rev] = pageId.split("#");

                    // `publishedPageData` will give us a record that contains `id` and `path, which tell us
                    // the current revision and over which path it has been published, respectively.
                    const [[[page]], [[publishedPage]], [[latestPage]]] = await db
                        .batch<[[Page]], [[Page]], [[Page]]>()
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `REV#${rev}` }
                        })
                        .read({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "P"
                            }
                        })
                        .read({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "L"
                            }
                        })
                        .execute();

                    if (!page) {
                        throw new NotFoundError(`Page "${pageId}" not found.`);
                    }

                    const identity = context.security.getIdentity();
                    checkOwnPermissions(identity, permission, page, "ownedBy");

                    if (page.status === STATUS_PUBLISHED) {
                        throw new NotFoundError(`Page "${pageId}" is already published.`);
                    }

                    const [[publishedPageOnPath]] = await db.read<Page>({
                        ...defaults.db,
                        query: {
                            PK: PK_PAGE_PUBLISHED_PATH(),
                            SK: page.path
                        }
                    });

                    await executeHookCallbacks(hookPlugins, "beforePublish", context, {
                        page,
                        latestPage,
                        publishedPage
                    });

                    const pathTakenByAnotherPage =
                        publishedPageOnPath && publishedPageOnPath.pid !== page.pid;

                    // If this is true, let's unpublish the page first. Note that we're not talking about this
                    // same page, but a previous revision. We're talking about a completely different page
                    // (with different PID). Remember that page ID equals `PID#version`.
                    if (pathTakenByAnotherPage) {
                        // Note two things here...
                        // 1) It is possible that this call is about to try to unpublish a page that is set as
                        // a special page (home / 404). In that case, this whole process will fail, and that
                        // is to be expected. Maybe we could think of a better solution in the future, but for
                        // now, it works like this. If there was only more ⏱.
                        // 2) If a user doesn't have the unpublish permission, again, the whole action will fail.
                        await this.unpublish(publishedPageOnPath.id);
                    }

                    // Now that the other page has been unpublished, we can continue with publish the current one.

                    // Change loaded page's status to published.
                    page.status = STATUS_PUBLISHED;
                    page.locked = true;
                    page.publishedOn = new Date().toISOString();

                    // We need to issue a couple of updates.
                    const batch = db.batch();

                    // 1. Update the page in the database first.
                    batch.update({
                        ...defaults.db,
                        query: {
                            PK: PK_PAGE(pid),
                            SK: `REV#${rev}`
                        },
                        data: page
                    });

                    // If we just published the latest version, update the latest revision entry too.
                    if (latestPage.id === pageId) {
                        batch.update({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "L"
                            },
                            data: { ...page, PK: PK_PAGE(pid), SK: "L" }
                        });
                    }

                    if (publishedPage) {
                        const [, publishedRev] = publishedPage.id.split("#");
                        batch
                            .update({
                                ...defaults.db,
                                query: {
                                    PK: PK_PAGE(pid),
                                    SK: `REV#${publishedRev}`
                                },
                                data: {
                                    ...publishedPage,
                                    status: STATUS_UNPUBLISHED,
                                    PK: PK_PAGE(pid),
                                    SK: `REV#${publishedRev}`
                                }
                            })
                            .update({
                                ...defaults.db,
                                query: {
                                    PK: PK_PAGE(pid),
                                    SK: "P"
                                },
                                data: { ...page, PK: PK_PAGE(pid), SK: "P" }
                            });

                        // If the paths are different, delete previous published-page-on-path entry.
                        if (publishedPage.path !== page.path) {
                            batch
                                .delete({
                                    ...defaults.db,
                                    query: {
                                        PK: PK_PAGE_PUBLISHED_PATH(),
                                        SK: publishedPage.path
                                    }
                                })
                                .create({
                                    ...defaults.db,
                                    data: {
                                        ...page,
                                        PK: PK_PAGE_PUBLISHED_PATH(),
                                        SK: page.path
                                    }
                                });
                        } else {
                            batch.update({
                                ...defaults.db,
                                query: {
                                    PK: PK_PAGE_PUBLISHED_PATH(),
                                    SK: page.path
                                },
                                data: {
                                    ...page,
                                    PK: PK_PAGE_PUBLISHED_PATH(),
                                    SK: page.path
                                }
                            });
                        }
                    } else {
                        batch
                            .create({
                                ...defaults.db,
                                data: {
                                    ...page,
                                    PK: PK_PAGE(pid),
                                    SK: "P"
                                }
                            })
                            .create({
                                ...defaults.db,
                                data: {
                                    ...page,
                                    PK: PK_PAGE_PUBLISHED_PATH(),
                                    SK: page.path
                                }
                            });
                    }

                    await batch.execute();

                    // Update data in ES.
                    const esOperations = [];

                    // If we are publishing the latest revision, let's also update the latest revision entry's
                    // status in ES. Also, if we are publishing the latest revision and the "LATEST page lists
                    // visibility" is not false, then we need to update the latest page revision entry in ES.
                    if (latestPage?.id === pageId && page?.visibility?.list?.latest !== false) {
                        esOperations.push(
                            {
                                index: {
                                    _id: `L#${pid}`,
                                    _index: ES_DEFAULTS().index
                                }
                            },
                            getESLatestPageData(context, page)
                        );
                    }

                    // And of course, update the published revision entry in ES. This time, if the "PUBLISHED page
                    // lists visibility" setting is not explicitly set to false.
                    if (page?.visibility?.list?.published !== false) {
                        esOperations.push(
                            { index: { _id: `P#${pid}`, _index: ES_DEFAULTS().index } },
                            getESPublishedPageData(context, {
                                ...page,
                                id: pageId,
                                status: STATUS_PUBLISHED,
                                locked: true
                            })
                        );
                    } else {
                        // If the page should not be visible in published pages lists, then delete the entry.
                        esOperations.push({
                            delete: { _id: `P#${pid}`, _index: ES_DEFAULTS().index }
                        });
                    }

                    await elasticSearch.bulk({ body: esOperations });

                    await executeHookCallbacks(hookPlugins, "afterPublish", context, {
                        page,
                        latestPage,
                        publishedPage
                    });

                    return page;
                },

                async unpublish(pageId: string) {
                    const permission = await checkBasePermissions<PageSecurityPermission>(
                        context,
                        PERMISSION_NAME,
                        {
                            pw: "u"
                        }
                    );

                    const [pid, rev] = pageId.split("#");

                    const [[[page]], [[publishedPage]], [[latestPage]]] = await db
                        .batch()
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `REV#${rev}` },
                            limit: 1
                        })
                        .read({
                            ...defaults.db,
                            limit: 1,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "P"
                            }
                        })
                        .read({
                            ...defaults.db,
                            limit: 1,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "L"
                            }
                        })
                        .execute();

                    if (!page) {
                        throw new NotFoundError(`Page "${pageId}" not found.`);
                    }

                    const identity = context.security.getIdentity();
                    checkOwnPermissions(identity, permission, page, "ownedBy");

                    if (!publishedPage || publishedPage.id !== pageId) {
                        throw new Error(`Page "${pageId}" is not published.`);
                    }

                    const settings = await context.pageBuilder.settings.default.get();
                    const pages = settings?.pages || {};
                    for (const key in pages) {
                        if (pages[key] === page.pid) {
                            throw new Error(`Cannot unpublish page because it's set as ${key}.`);
                        }
                    }

                    await executeHookCallbacks(hookPlugins, "beforeUnpublish", context, page);

                    page.status = STATUS_UNPUBLISHED;

                    await db
                        .batch()
                        .delete({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "P"
                            }
                        })
                        .delete({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE_PUBLISHED_PATH(),
                                SK: publishedPage.path
                            }
                        })
                        .update({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: `REV#${rev}`
                            },
                            data: page
                        })
                        .execute();

                    // Update data in ES.
                    const esOperations = [];

                    // If we are unpublishing the latest revision, let's also update the latest revision entry's
                    // status in ES. We can only do that if the entry actually exists, or in other words, if the
                    // published page's "LATEST pages lists visibility" setting is not set to false.
                    if (latestPage.id === pageId && page?.visibility?.list?.latest !== false) {
                        esOperations.push(
                            {
                                update: {
                                    _id: `L#${pid}`,
                                    _index: ES_DEFAULTS().index
                                }
                            },
                            { doc: { status: STATUS_UNPUBLISHED } }
                        );
                    }

                    // And of course, delete the published revision entry in ES.
                    if (page?.visibility?.list?.published !== false) {
                        esOperations.push({
                            delete: { _id: `P#${pid}`, _index: ES_DEFAULTS().index }
                        });
                    }

                    if (esOperations.length) {
                        await elasticSearch.bulk({ body: esOperations });
                    }

                    await executeHookCallbacks(hookPlugins, "afterUnpublish", context, page);

                    return page;
                },

                async requestReview(pageId: string) {
                    const permission = await checkBasePermissions(context, PERMISSION_NAME, {
                        pw: "r"
                    });

                    const [pid, rev] = pageId.split("#");

                    const [[[page]], [[latestPageData]]] = await db
                        .batch()
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `REV#${rev}` }
                        })
                        .read({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "L"
                            }
                        })
                        .execute();

                    if (!page) {
                        throw new NotFoundError(`Page "${pageId}" not found.`);
                    }

                    const allowedStatuses = [STATUS_DRAFT, STATUS_CHANGES_REQUESTED];
                    if (!allowedStatuses.includes(page.status)) {
                        throw new Error(
                            `Cannot request review - page is not a draft nor a change request has been issued.`
                        );
                    }

                    const identity = context.security.getIdentity();
                    checkOwnPermissions(identity, permission, page, "ownedBy");

                    // Change loaded page's status to `reviewRequested`.
                    page.status = STATUS_REVIEW_REQUESTED;
                    page.locked = true;

                    await db.update({
                        ...defaults.db,
                        query: {
                            PK: PK_PAGE(pid),
                            SK: `REV#${rev}`
                        },
                        data: omit(page, ["PK", "SK"])
                    });

                    // If we updated the latest version, then make sure the changes are propagated to ES too.
                    if (latestPageData.id === pageId) {
                        // 0nly update if the "LATEST pages lists visibility" is not set to false.
                        if (page?.visibility?.list?.latest !== false) {
                            const [uniqueId] = pageId.split("#");
                            // Index file in "Elastic Search"
                            await elasticSearch.update({
                                ...ES_DEFAULTS(),
                                id: `L#${uniqueId}`,
                                body: {
                                    doc: {
                                        status: STATUS_REVIEW_REQUESTED,
                                        locked: true
                                    }
                                }
                            });
                        }
                    }

                    return page;
                },

                async requestChanges(pageId: string) {
                    const permission = await checkBasePermissions(context, PERMISSION_NAME, {
                        pw: "c"
                    });

                    const [pid, rev] = pageId.split("#");

                    const [[[page]], [[latestPageData]]] = await db
                        .batch()
                        .read({
                            ...defaults.db,
                            query: { PK: PK_PAGE(pid), SK: `REV#${rev}` }
                        })
                        .read({
                            ...defaults.db,
                            query: {
                                PK: PK_PAGE(pid),
                                SK: "L"
                            }
                        })
                        .execute();

                    if (!page) {
                        throw new NotFoundError(`Page "${pageId}" not found.`);
                    }

                    if (page.status !== STATUS_REVIEW_REQUESTED) {
                        throw new Error(
                            `Cannot request changes on a page that's not under review.`,
                            "REQUESTED_CHANGES_ON_PAGE_REVISION_NOT_UNDER_REVIEW"
                        );
                    }

                    const identity = context.security.getIdentity();
                    if (page.createdBy.id === identity.id) {
                        throw new Error(
                            "Cannot request changes on page revision you created.",
                            "REQUESTED_CHANGES_ON_PAGE_REVISION_YOU_CREATED"
                        );
                    }

                    checkOwnPermissions(identity, permission, page, "ownedBy");

                    // Change loaded page's status to published.
                    page.status = STATUS_CHANGES_REQUESTED;
                    page.locked = false;

                    await db.update({
                        ...defaults.db,
                        query: {
                            PK: PK_PAGE(pid),
                            SK: `REV#${rev}`
                        },
                        data: omit(page, ["PK", "SK"])
                    });

                    // If we updated the latest version, then make sure the changes are propagated to ES too.
                    if (latestPageData.id === pageId) {
                        // 0nly update if the "LATEST pages lists visibility" is not set to false.
                        if (page?.visibility?.list?.latest !== false) {
                            const [uniqueId] = pageId.split("#");
                            // Index file in "Elastic Search"
                            await elasticSearch.update({
                                ...ES_DEFAULTS(),
                                id: `L#${uniqueId}`,
                                body: {
                                    doc: {
                                        status: STATUS_CHANGES_REQUESTED,
                                        locked: false
                                    }
                                }
                            });
                        }
                    }

                    return page;
                },

                prerendering: {
                    async render(args) {
                        const current = await context.pageBuilder.settings.default.get();
                        const defaults = await context.pageBuilder.settings.default.getDefault();

                        const appUrl =
                            current?.prerendering?.app?.url || defaults?.prerendering?.app?.url;

                        const storageName =
                            current?.prerendering?.storage?.name ||
                            defaults?.prerendering?.storage?.name;

                        if (!appUrl || !storageName) {
                            return;
                        }

                        const meta = merge(
                            defaults?.prerendering?.meta,
                            current?.prerendering?.meta
                        );

                        const { paths, tags } = args;

                        const dbNamespace = "T#" + context.security.getTenant().id;

                        if (Array.isArray(paths)) {
                            await context.prerenderingServiceClient.render(
                                paths.map(item => ({
                                    url: appUrl + item.path,
                                    configuration: merge(
                                        {
                                            meta,
                                            storage: {
                                                folder: trimStart(item.path, "/"),
                                                name: storageName
                                            },
                                            db: {
                                                namespace: dbNamespace
                                            }
                                        },
                                        item.configuration
                                    )
                                }))
                            );
                        }

                        if (Array.isArray(tags)) {
                            await context.prerenderingServiceClient.queue.add(
                                tags.map(item => ({
                                    render: {
                                        tag: item.tag,
                                        configuration: merge(
                                            {
                                                db: {
                                                    namespace: dbNamespace
                                                }
                                            },
                                            item.configuration
                                        )
                                    }
                                }))
                            );
                        }
                    },
                    async flush(args) {
                        const current = await context.pageBuilder.settings.default.get();
                        const defaults = await context.pageBuilder.settings.default.getDefault();

                        const appUrl =
                            current?.prerendering?.app?.url || defaults?.prerendering?.app?.url;

                        const storageName =
                            current?.prerendering?.storage?.name ||
                            defaults?.prerendering?.storage?.name;

                        if (!storageName) {
                            return;
                        }

                        const { paths, tags } = args;

                        const dbNamespace = "T#" + context.security.getTenant().id;

                        if (Array.isArray(paths)) {
                            await context.prerenderingServiceClient.flush(
                                paths.map<FlushArgs>(p => ({
                                    url: appUrl + p.path,
                                    // Configuration is mainly static (defined here), but some configuration
                                    // overrides can arrive via the call args, so let's do a merge here.
                                    configuration: merge(
                                        {
                                            db: {
                                                namespace: dbNamespace
                                            }
                                        },
                                        p.configuration
                                    )
                                }))
                            );
                        }

                        if (Array.isArray(tags)) {
                            await context.prerenderingServiceClient.queue.add(
                                tags.map(item => ({
                                    flush: {
                                        tag: item.tag,
                                        configuration: merge(
                                            {
                                                db: {
                                                    namespace: dbNamespace
                                                }
                                            },
                                            item.configuration
                                        )
                                    }
                                }))
                            );
                        }
                    }
                }
            }
        };
    }
};

export default plugin;
