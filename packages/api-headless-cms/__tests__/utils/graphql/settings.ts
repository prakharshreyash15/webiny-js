export const IS_INSTALLED_QUERY = /* GraphQL */ `
    query IsCmsInstalled {
        cms {
            isInstalled {
                data
                error {
                    message
                    code
                    data
                }
            }
        }
    }
`;

export const INSTALL_MUTATION = /* GraphQL */ `
    mutation CmsInstall {
        cms {
            install {
                data
                error {
                    message
                    code
                    data
                }
            }
        }
    }
`;
