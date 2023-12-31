import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  AuthResources,
  BackendOutputStorageStrategy,
  ConstructContainerEntryGenerator,
  ConstructFactory,
  ConstructFactoryGetInstanceProps,
  ResourceProvider,
} from '@aws-amplify/plugin-types';
import {
  AmplifyGraphqlApi,
  AmplifyGraphqlApiProps,
  AmplifyGraphqlDefinition,
  AuthorizationModes,
  IAMAuthorizationConfig,
  IAmplifyGraphqlDefinition,
  UserPoolAuthorizationConfig,
} from '@aws-amplify/graphql-api-construct';
import { GraphqlOutput } from '@aws-amplify/backend-output-schemas';
import * as path from 'path';
import { DerivedModelSchema } from '@aws-amplify/amplify-api-next-types-alpha';
import { AccountPrincipal, Effect, Policy, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Bucket, HttpMethods } from 'aws-cdk-lib/aws-s3';

/**
 * Exposed props for Data which are configurable by the end user.
 */
export type DataProps = {
  /**
   * Graphql Schema as a string to be passed into the CDK construct.
   */
  schema: string | DerivedModelSchema;

  /**
   * Optional name for the generated Api.
   */
  name?: string;

  /**
   * Temporary authZ pass-through into the CDK construct
   * https://github.com/aws-amplify/samsara-cli/issues/370
   */
  authorizationModes?: AuthorizationModes;
};

/**
 * Singleton factory for AmplifyGraphqlApi constructs that can be used in Amplify project files
 */
class DataFactory implements ConstructFactory<AmplifyGraphqlApi> {
  private generator: ConstructContainerEntryGenerator;

  /**
   * Create a new AmplifyConstruct
   */
  constructor(
    private readonly props: DataProps,
    private readonly importStack = new Error().stack
  ) {}

  /**
   * Gets an instance of the Data construct
   */
  getInstance = ({
    constructContainer,
    outputStorageStrategy,
    importPathVerifier,
  }: ConstructFactoryGetInstanceProps): AmplifyGraphqlApi => {
    importPathVerifier?.verify(
      this.importStack,
      path.join('amplify', 'data', 'resource'),
      'Amplify Data must be defined in amplify/data/resource.ts'
    );
    if (!this.generator) {
      this.generator = new DataGenerator(
        this.props,
        constructContainer
          .getConstructFactory<ResourceProvider<AuthResources>>('AuthResources')
          .getInstance({
            constructContainer,
            outputStorageStrategy,
            importPathVerifier,
          }),
        outputStorageStrategy
      );
    }
    return constructContainer.getOrCompute(this.generator) as AmplifyGraphqlApi;
  };
}

class DataGenerator implements ConstructContainerEntryGenerator {
  readonly resourceGroupName = 'data';
  private readonly defaultName = 'amplifyData';

  constructor(
    private readonly props: DataProps,
    private readonly authResources: ResourceProvider<AuthResources>,
    private readonly outputStorageStrategy: BackendOutputStorageStrategy<GraphqlOutput>
  ) {}

  generateContainerEntry = (scope: Construct) => {
    let iamConfig: IAMAuthorizationConfig | undefined = undefined;
    let defaultAuthorizationMode: AuthorizationModes['defaultAuthorizationMode'] =
      'AWS_IAM';
    if (
      this.authResources.resources.authenticatedUserIamRole &&
      this.authResources.resources.unauthenticatedUserIamRole &&
      this.authResources.resources.cfnResources.identityPool.logicalId
    ) {
      iamConfig = {
        authenticatedUserRole:
          this.authResources.resources.authenticatedUserIamRole,
        unauthenticatedUserRole:
          this.authResources.resources.unauthenticatedUserIamRole,
        identityPoolId:
          this.authResources.resources.cfnResources.identityPool.logicalId,
      };
    }

    let userPoolConfig: UserPoolAuthorizationConfig | undefined = undefined;
    if (this.authResources.resources.userPool) {
      userPoolConfig = {
        userPool: this.authResources.resources.userPool,
      };
      defaultAuthorizationMode = 'AMAZON_COGNITO_USER_POOLS';
    }

    const dataAuthorizationModes = this.props.authorizationModes || {};

    /* BEGIN CUSTOM CODE */
    const stack = Stack.of(scope);
    const backendId = stack.node.getContext('backend-id');
    const branchName = stack.node.tryGetContext('branch-name') || 'sandbox';
    const roleName = `amplify-cms-manage-role-${backendId}-${branchName}`;
    const cmsManageRole = new Role(scope, 'AmplifyCMSManageRole', {
      roleName,
      assumedBy: new AccountPrincipal(Stack.of(scope).account),
    });
    /* END CUSTOM CODE */

    const authorizationModes: AuthorizationModes = {
      defaultAuthorizationMode,
      iamConfig,
      userPoolConfig,
      adminRoles: [cmsManageRole],
      ...dataAuthorizationModes,
    };

    const isModelSchema = (
      schema: DataProps['schema']
    ): schema is DerivedModelSchema => {
      if (
        schema !== null &&
        typeof schema === 'object' &&
        typeof schema.transform === 'function'
      ) {
        return true;
      }
      return false;
    };

    const normalizeSchema = (
      schema: DataProps['schema']
    ): IAmplifyGraphqlDefinition => {
      if (isModelSchema(schema)) {
        return schema.transform();
      }

      return AmplifyGraphqlDefinition.fromString(schema);
    };

    // TODO inject the construct with the functionNameMap
    const graphqlConstructProps: AmplifyGraphqlApiProps = {
      apiName: this.props.name,
      definition: normalizeSchema(this.props.schema),
      authorizationModes,
      outputStorageStrategy: this.outputStorageStrategy,
    };

    const api = new AmplifyGraphqlApi(
      scope,
      this.defaultName,
      graphqlConstructProps
    );

    /* START CUSTOM CODE */
    const inlineApiPolicy = new Policy(scope, 'AmplifyCMSManageRolePolicy');
    inlineApiPolicy.addStatements(new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [api.resources.graphqlApi.arn],
      actions: ['appsync:GraphQL']
    }));
    cmsManageRole.attachInlinePolicy(inlineApiPolicy);

    const codegenAssetsBucket = api.node.findChild('AmplifyCodegenAssets').node.findChild('AmplifyCodegenAssetsBucket') as Bucket;
    codegenAssetsBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET],
      allowedHeaders: ['*'],
      allowedOrigins: ['https://localhost.console.aws.amazon.com:3000',
        'https://*.console.aws.amazon.com/amplify/home',
        'https://532897458220-amplify-console.us-east-1.console.aws-dev.amazon.com/amplify/home']
    });
    /* END CUSTOM CODE */

    return api;
  };
}

/**
 * Creates a factory that implements ConstructFactory<AmplifyGraphqlApi>
 */
export const defineData = (
  props: DataProps
): ConstructFactory<AmplifyGraphqlApi> =>
  new DataFactory(props, new Error().stack);

