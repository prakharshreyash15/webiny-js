import React, { Fragment, useCallback, useMemo } from "react";
import { Grid, Cell } from "@webiny/ui/Grid";
import { Select } from "@webiny/ui/Select";
import { i18n } from "@webiny/app/i18n";
import {
    PermissionInfo,
    gridNoPaddingClass
} from "@webiny/app-security-tenancy/components/permission";
import { Form } from "@webiny/form";
import { Elevation } from "@webiny/ui/Elevation";
import { Typography } from "@webiny/ui/Typography";
import CustomSection from "./CustomSection";
import { Checkbox, CheckboxGroup } from "@webiny/ui/Checkbox";

const t = i18n.ns("app-page-builder/admin/plugins/permissionRenderer");

const PAGE_BUILDER = "pb";
const PAGE_BUILDER_FULL_ACCESS = "pb.*";
const PAGE_BUILDER_SETTINGS_ACCESS = `${PAGE_BUILDER}.settings`;
const FULL_ACCESS = "full";
const NO_ACCESS = "no";
const CUSTOM_ACCESS = "custom";
const ENTITIES = ["category", "menu", "page"];

const rcpuOptions = [
    { id: "p", name: t`Publish` },
    { id: "u", name: t`Unpublish` },
    { id: "r", name: t`Request review` },
    { id: "c", name: t`Request changes` }
];

export const PageBuilderPermissions = ({ securityGroup, value, onChange }) => {
    const onFormChange = useCallback(
        formData => {
            let newValue = [];
            if (Array.isArray(value)) {
                // Let's just filter out the `pb*` permission objects, it's easier to build new ones from scratch.
                newValue = value.filter(item => !item.name.startsWith(PAGE_BUILDER));
            }

            if (formData.accessLevel === NO_ACCESS) {
                onChange(newValue);
                return;
            }

            if (formData.accessLevel === FULL_ACCESS) {
                newValue.push({ name: PAGE_BUILDER_FULL_ACCESS });
                onChange(newValue);
                return;
            }

            // Handling custom access level.

            // Categories, menus, and pages first.
            ENTITIES.forEach(entity => {
                if (
                    formData[`${entity}AccessLevel`] &&
                    formData[`${entity}AccessLevel`] !== NO_ACCESS
                ) {
                    const permission: Record<string, any> = {
                        name: `${PAGE_BUILDER}.${entity}`
                    };

                    if (formData[`${entity}AccessLevel`] === "own") {
                        permission.own = true;
                    }

                    if (Array.isArray(formData[`${entity}Rwd`])) {
                        const rwd = formData[`${entity}Rwd`].reduce(
                            (current, item) => current + item,
                            ""
                        );

                        if (rwd) {
                            permission.rwd = rwd;
                        }
                    }

                    // For pages, we can also manage publishing and reviewing of pages.
                    if (entity === "page") {
                        if (Array.isArray(formData[`${entity}Rcpu`])) {
                            const rcpu = formData[`${entity}Rcpu`].reduce(
                                (current, item) => current + item,
                                ""
                            );

                            if (rcpu) {
                                permission.rcpu = rcpu;
                            }
                        }
                    }

                    newValue.push(permission);
                }
            });

            // Settings.
            if (formData.settingsAccessLevel === FULL_ACCESS) {
                newValue.push({ name: PAGE_BUILDER_SETTINGS_ACCESS });
            }

            onChange(newValue);
        },
        [securityGroup.id, value]
    );

    const formData = useMemo(() => {
        if (!Array.isArray(value)) {
            return { accessLevel: NO_ACCESS };
        }

        const hasFullAccess = value.find(
            item => item.name === PAGE_BUILDER_FULL_ACCESS || item.name === "*"
        );
        if (hasFullAccess) {
            return { accessLevel: FULL_ACCESS };
        }

        const permissions = value.filter(item => item.name.startsWith(PAGE_BUILDER));
        if (!permissions.length) {
            return { accessLevel: NO_ACCESS };
        }

        // We're dealing with custom permissions. Let's first prepare data for "categories", "menus", and "pages".
        const formData: Record<string, any> = {
            accessLevel: CUSTOM_ACCESS,
            settingsAccessLevel: NO_ACCESS
        };

        ENTITIES.forEach(entity => {
            const data: Record<string, any> = {
                [`${entity}AccessLevel`]: NO_ACCESS,
                [`${entity}Rwd`]: []
            };

            const entityPermission = permissions.find(
                item => item.name === `${PAGE_BUILDER}.${entity}`
            );

            if (entityPermission) {
                data[`${entity}AccessLevel`] = entityPermission.own ? "own" : FULL_ACCESS;
                data[`${entity}Rwd`] = entityPermission.rwd ? [...entityPermission.rwd] : [];

                // For pages, we can also manage publishing and reviewing of pages.
                if (entity === "page") {
                    data[`${entity}Rcpu`] = entityPermission.rcpu ? [...entityPermission.rcpu] : [];
                }
            }

            Object.assign(formData, data);
        });

        // Finally, let's prepare data for Page Builder settings.
        const hasSettingsAccess = permissions.find(
            item => item.name === PAGE_BUILDER_SETTINGS_ACCESS
        );
        if (hasSettingsAccess) {
            formData.settingsAccessLevel = FULL_ACCESS;
        }

        return formData;
    }, [securityGroup.id]);

    return (
        <Form data={formData} onChange={onFormChange}>
            {({ data, Bind }) => (
                <Fragment>
                    <Grid className={gridNoPaddingClass}>
                        <Cell span={6}>
                            <PermissionInfo title={t`Access Level`} />
                        </Cell>
                        <Cell span={6}>
                            <Bind name={"accessLevel"}>
                                <Select label={t`Access Level`}>
                                    <option value={NO_ACCESS}>{t`No access`}</option>
                                    <option value={FULL_ACCESS}>{t`Full Access`}</option>
                                    <option value={CUSTOM_ACCESS}>{t`Custom Access`}</option>
                                </Select>
                            </Bind>
                        </Cell>
                    </Grid>
                    {data.accessLevel === CUSTOM_ACCESS && (
                        <Fragment>
                            <CustomSection
                                data={data}
                                Bind={Bind}
                                entity={"category"}
                                title={"Categories"}
                            />
                            <CustomSection
                                data={data}
                                Bind={Bind}
                                entity={"menu"}
                                title={"Menus"}
                            />

                            <CustomSection data={data} Bind={Bind} entity={"page"} title={"Pages"}>
                                <Cell span={12}>
                                    <Cell span={12}>
                                        <Bind name={"pageRcpu"}>
                                            <CheckboxGroup
                                                label={t`Publishing workflow`}
                                                description={t`Publishing-related actions that can be performed on the content.`}
                                            >
                                                {({ getValue, onChange }) =>
                                                    rcpuOptions.map(({ id, name }) => (
                                                        <Checkbox
                                                            disabled={
                                                                !["full", "own"].includes(
                                                                    data.pageAccessLevel
                                                                )
                                                            }
                                                            key={id}
                                                            label={name}
                                                            value={getValue(id)}
                                                            onChange={onChange(id)}
                                                        />
                                                    ))
                                                }
                                            </CheckboxGroup>
                                        </Bind>
                                    </Cell>
                                </Cell>
                            </CustomSection>

                            <Elevation z={1} style={{ marginTop: 10 }}>
                                <Grid>
                                    <Cell span={12}>
                                        <Typography use={"overline"}>{t`Settings`}</Typography>
                                    </Cell>
                                    <Cell span={12}>
                                        <Grid style={{ padding: 0, paddingBottom: 24 }}>
                                            <Cell span={6}>
                                                <PermissionInfo title={t`Manage settings`} />
                                            </Cell>
                                            <Cell span={6} align={"middle"}>
                                                <Bind name={"settingsAccessLevel"}>
                                                    <Select label={t`Access Level`}>
                                                        <option
                                                            value={NO_ACCESS}
                                                        >{t`No access`}</option>
                                                        <option
                                                            value={FULL_ACCESS}
                                                        >{t`Full Access`}</option>
                                                    </Select>
                                                </Bind>
                                            </Cell>
                                        </Grid>
                                    </Cell>
                                </Grid>
                            </Elevation>
                        </Fragment>
                    )}
                </Fragment>
            )}
        </Form>
    );
};